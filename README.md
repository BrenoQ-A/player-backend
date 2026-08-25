# Player Backend

Backend Node.js/Express do projeto de sinalização digital. A imagem de produção é publicada no GitHub Container Registry em `ghcr.io/brenoq-a/player-backend:<sha>` e executada no Azure Container Apps.

## Deploy automático

O workflow `.github/workflows/publish-container.yml` publica duas tags a cada alteração do backend na branch `main`:

- `ghcr.io/brenoq-a/player-backend:latest`
- `ghcr.io/brenoq-a/player-backend:<github-sha>`

Após o push da imagem, o mesmo workflow autentica no Azure via OIDC, atualiza o Container App `player-backend` no resource group `rg-player-sinalizacao` usando sempre a tag imutável do commit e, em seguida, consulta `/health` por até dois minutos. O workflow falha caso a nova revisão não responda HTTP 200.

### Autenticação OIDC

O repositório usa federação de identidade entre GitHub Actions e Microsoft Entra ID, sem client secret de longa duração.

O GitHub Actions precisa destes repository secrets:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

O workflow solicita `id-token: write` apenas para obter o token OIDC temporário. A autorização efetiva no Azure é controlada por RBAC.

A identidade federada deve permanecer restrita ao repositório `BrenoQ-A/player-backend`, branch `main`, e possuir apenas a função necessária para atualizar o Container App de produção, preferencialmente `Container Apps Contributor` no escopo do próprio recurso `player-backend`.

Não criar nem versionar `AZURE_CREDENTIALS`, client secret ou senha para este fluxo.

## Rollback manual

Use uma imagem conhecida e imutável de um commit anterior:

```bash
az containerapp update \
  --name player-backend \
  --resource-group rg-player-sinalizacao \
  --image ghcr.io/brenoq-a/player-backend:<SHA_ANTERIOR>
```

Depois do rollback, valide:

```bash
curl -f https://player-backend.ambitiouswave-c76e39f5.brazilsouth.azurecontainerapps.io/health
```

## Segurança

Segredos como `JWT_SECRET`, `GITHUB_TOKEN` e credenciais do R2 nunca devem ser incluídos em commits, logs ou documentação pública. No Azure Container Apps, valores sensíveis devem ser mantidos como secrets e referenciados por `secretref:` quando aplicável.
