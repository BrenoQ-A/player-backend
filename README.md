# Player Backend

Backend Node.js/Express do projeto de sinalização digital. A imagem de produção é publicada no GitHub Container Registry em `ghcr.io/brenoq-a/player-backend:<sha>` e executada no Azure Container Apps.

## Deploy automático

O workflow `.github/workflows/publish-container.yml` publica duas tags a cada alteração do backend na branch `main`:

- `ghcr.io/brenoq-a/player-backend:latest`
- `ghcr.io/brenoq-a/player-backend:<github-sha>`

Após o push da imagem, o mesmo workflow atualiza o Container App `player-backend` no resource group `rg-player-sinalizacao` usando sempre a tag imutável do commit. Em seguida, consulta `/health` por até dois minutos e falha caso a nova revisão não responda HTTP 200.

### Pré-requisito de autenticação

Criar no GitHub Actions o secret `AZURE_CREDENTIALS` contendo as credenciais do service principal usado pelo workflow. Não versionar o valor desse secret. A identidade deve receber somente as permissões necessárias para atualizar o Container App, preferencialmente com RBAC no menor escopo possível.

> Antes de mesclar a automação de deploy, confirme que `AZURE_CREDENTIALS` existe e que a identidade consegue executar `az containerapp update` no app de produção.

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

Segredos como `JWT_SECRET`, `GITHUB_TOKEN`, credenciais do R2 e credenciais do Azure nunca devem ser incluídos em commits, logs ou documentação pública. No Azure Container Apps, valores sensíveis devem ser mantidos como secrets e referenciados por `secretref:` quando aplicável.
