'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function assertSafeKey(key) {
  if (!key || key.startsWith('/') || key.split('/').includes('..')) {
    throw new Error('Chave de armazenamento inválida: ' + key);
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createStorage(options) {
  const opts = options || {};
  const driver = opts.driver || process.env.STORAGE_DRIVER || 'local';
  const localDir = path.resolve(
    opts.localDir || process.env.STORAGE_LOCAL_DIR || path.join(process.cwd(), 'data')
  );
  const publicBaseUrl = stripTrailingSlash(
    opts.publicBaseUrl || process.env.STORAGE_PUBLIC_BASE_URL ||
    ((process.env.BACKEND_PUBLIC_URL || 'http://localhost:' + (process.env.PORT || 3000)) + '/storage')
  );

  let s3 = null;
  let bucket = null;

  if (driver === 's3') {
    bucket = opts.bucket || process.env.STORAGE_BUCKET;
    const region = opts.region || process.env.STORAGE_REGION || 'auto';
    const endpoint = opts.endpoint || process.env.STORAGE_ENDPOINT || undefined;
    const accessKeyId = opts.accessKeyId || process.env.STORAGE_ACCESS_KEY_ID;
    const secretAccessKey = opts.secretAccessKey || process.env.STORAGE_SECRET_ACCESS_KEY;

    if (!bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) {
      throw new Error(
        'Armazenamento S3 incompleto. Configure STORAGE_BUCKET, ' +
        'STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY e STORAGE_PUBLIC_BASE_URL.'
      );
    }

    s3 = new S3Client({
      region,
      endpoint,
      forcePathStyle: String(
        opts.forcePathStyle !== undefined
          ? opts.forcePathStyle
          : process.env.STORAGE_FORCE_PATH_STYLE || 'false'
      ) === 'true',
      credentials: { accessKeyId, secretAccessKey }
    });
  } else if (driver !== 'local') {
    throw new Error('STORAGE_DRIVER deve ser "local" ou "s3".');
  }

  function localPath(key) {
    assertSafeKey(key);
    const resolved = path.resolve(localDir, key);
    if (resolved !== localDir && !resolved.startsWith(localDir + path.sep)) {
      throw new Error('Caminho de armazenamento inválido.');
    }
    return resolved;
  }

  async function ensureLocalParent(key) {
    await fsp.mkdir(path.dirname(localPath(key)), { recursive: true });
  }

  async function putFile(key, filePath, contentType, cacheControl, onProgress) {
    assertSafeKey(key);
    if (driver === 'local') {
      await ensureLocalParent(key);
      await fsp.copyFile(filePath, localPath(key));
      if (onProgress) {
        const stat = await fsp.stat(filePath);
        onProgress({ loaded: stat.size, total: stat.size, percent: 100 });
      }
      return;
    }

    const stat = await fsp.stat(filePath);
    const uploadConcurrency = Math.max(
      1,
      Number(process.env.STORAGE_UPLOAD_CONCURRENCY || 1)
    );
    const uploadPartSize = Math.max(
      5,
      Number(process.env.STORAGE_UPLOAD_PART_MB || 8)
    ) * 1024 * 1024;
    const upload = new Upload({
      client: s3,
      queueSize: uploadConcurrency,
      partSize: uploadPartSize,
      leavePartsOnError: false,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: stat.size,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: cacheControl || undefined
      }
    });
    if (onProgress) {
      upload.on('httpUploadProgress', (progress) => {
        const loaded = Number(progress.loaded) || 0;
        const total = Number(progress.total) || stat.size;
        onProgress({
          loaded,
          total,
          percent: total > 0 ? Math.min(100, loaded / total * 100) : 0
        });
      });
    }
    await upload.done();
  }

  async function getFile(key, filePath) {
    assertSafeKey(key);
    if (driver === 'local') {
      try {
        await fsp.copyFile(localPath(key), filePath);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') { return false; }
        throw error;
      }
    }

    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(result.Body, fs.createWriteStream(filePath));
      return true;
    } catch (error) {
      await fsp.unlink(filePath).catch(() => {});
      const status = error.$metadata && error.$metadata.httpStatusCode;
      if (status === 404 || error.name === 'NoSuchKey') { return false; }
      throw error;
    }
  }

  async function putBuffer(key, buffer, contentType, cacheControl) {
    assertSafeKey(key);
    if (driver === 'local') {
      await ensureLocalParent(key);
      await fsp.writeFile(localPath(key), buffer);
      return;
    }

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
      CacheControl: cacheControl || undefined
    }));
  }

  async function getBuffer(key) {
    assertSafeKey(key);
    if (driver === 'local') {
      try {
        return await fsp.readFile(localPath(key));
      } catch (error) {
        if (error.code === 'ENOENT') { return null; }
        throw error;
      }
    }

    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return streamToBuffer(result.Body);
    } catch (error) {
      const status = error.$metadata && error.$metadata.httpStatusCode;
      if (status === 404 || error.name === 'NoSuchKey') { return null; }
      throw error;
    }
  }

  async function deleteObject(key) {
    assertSafeKey(key);
    if (driver === 'local') {
      await fsp.unlink(localPath(key)).catch((error) => {
        if (error.code !== 'ENOENT') { throw error; }
      });
      return;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async function getJson(key, fallback) {
    const buffer = await getBuffer(key);
    if (!buffer) { return fallback; }
    return JSON.parse(buffer.toString('utf8'));
  }

  async function putJson(key, value) {
    const buffer = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await putBuffer(key, buffer, 'application/json; charset=utf-8', 'no-cache');
  }

  function publicUrl(key) {
    assertSafeKey(key);
    return publicBaseUrl + '/' + encodeKey(key);
  }

  return {
    driver,
    localDir,
    publicBaseUrl,
    putFile,
    putBuffer,
    getFile,
    getBuffer,
    deleteObject,
    getJson,
    putJson,
    publicUrl
  };
}

module.exports = { createStorage };
