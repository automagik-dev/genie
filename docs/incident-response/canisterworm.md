# Manual de Resposta ao Incidente — CanisterWorm

> **Publicado por:** Namastex Labs Serviços em Tecnologia Ltda — CNPJ 46.156.854/0001-62
> **Versão:** 1.0 · 2026-04-23
> **Classificação:** Público — distribuição livre para quem tenha instalado qualquer versão afetada
> **Páginas relacionadas:** [automagik.dev/security](https://automagik.dev/security) (EN) · [automagik.dev/seguranca](https://automagik.dev/seguranca) (PT)

---

## Sobre este documento

Entre 21 e 22 de abril de 2026, versões maliciosas dos pacotes npm `@automagik/genie` e `pgserve` (publicados pela Namastex Labs) foram carregadas no registro público após o comprometimento de um token de desenvolvedor interno. Assumimos responsabilidade por este incidente. Este manual existe para ajudar **qualquer pessoa ou organização** que tenha instalado as versões afetadas a verificar se foi comprometida e, em caso afirmativo, remediar de forma estruturada.

Se você instalou qualquer versão listada abaixo entre **2026-04-21 e 2026-04-22**, leia este documento do início ao fim antes de executar qualquer comando.

---

## 1. O que aconteceu

### 1.1 Resumo

- **Família de malware:** CanisterWorm
- **Ator atribuído:** TeamPCP
- **Vetor primário:** token GitHub OAuth de um desenvolvedor Namastex foi exfiltrado e utilizado para publicar versões contaminadas.
- **Mecanismo:** hook `postinstall` roda no momento da instalação do pacote, coleta credenciais locais e exfiltra para infraestrutura de comando e controle via HTTPS.
- **Propagação (worm):** utiliza o token npm roubado para republicar versões contaminadas de outros pacotes em que a vítima tenha permissão de publish.

### 1.2 Pacotes e versões maliciosas

| Pacote | Versões comprometidas | Status no npm |
|--------|-----------------------|----------------|
| `@automagik/genie` | `4.260421.33` até `4.260421.40` | Depreciadas e removidas |
| `pgserve` | `1.1.11`, `1.1.12`, `1.1.13`, `1.1.14` | Depreciadas e removidas |

### 1.3 Versões limpas

| Pacote | Versão segura |
|--------|---------------|
| `@automagik/genie` | `4.260422.4` ou posterior |
| `pgserve` | `1.1.10` |

> ⚠️ A partir de 2026-04-23 toda publicação Namastex é assinada com `npm --provenance`. Prefira verificar proveniência antes de instalar: `npm view <pacote> --json | jq '.dist.attestations'`.

### 1.4 O que o malware coleta

Se qualquer versão maliciosa foi instalada na sua máquina, os itens abaixo foram potencialmente exfiltrados no momento da instalação:

- **Tokens npm** — `~/.npmrc`
- **Chaves SSH** — `~/.ssh/id_*` (privadas e públicas)
- **Tokens GitHub CLI / OAuth** — `~/.config/gh/hosts.yml`
- **Credenciais cloud** — `~/.aws/`, `~/.azure/`, `~/.config/gcloud/`
- **kubeconfig** — `~/.kube/config`, tokens de service account `/var/run/secrets/kubernetes.io/`
- **Arquivos `.env`** — qualquer `.env` acessível no workspace
- **Histórico de shell** — `~/.bash_history`, `~/.zsh_history`
- **Senhas salvas** — Chrome/Chromium/Edge/Firefox
- **Carteiras crypto** — MetaMask, Phantom, Exodus, Atomic (seed phrases)
- **LLM API keys** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` em `.env` ou variável de ambiente
- **Variáveis de ambiente de processos em execução** — via `/proc/<pid>/environ`
- **Credenciais Docker registry** — `~/.docker/config.json`
- **Chaves privadas TLS**

> ⚠️ **Leitura crítica:** o roubo aconteceu no momento da instalação. Rotacionar chaves no GitHub **não desfaz** o que já foi exfiltrado — você precisa rotacionar **todos** os itens listados acima.

---

## 2. Passo 1 — Identificar se você foi afetado

Execute todos os checks abaixo. Anote resultados antes de seguir para o Passo 2.

### 2.1 Versão instalada globalmente (bun)

```bash
# Caminho padrão
cat ~/.bun/install/global/node_modules/@automagik/genie/package.json 2>/dev/null | grep '"version"'
cat ~/.bun/install/global/node_modules/pgserve/package.json 2>/dev/null | grep '"version"'

# Caminho alternativo (bun mais recente)
cat ~/.cache/.bun/install/global/node_modules/@automagik/genie/package.json 2>/dev/null | grep '"version"'
cat ~/.cache/.bun/install/global/node_modules/pgserve/package.json 2>/dev/null | grep '"version"'
```

### 2.2 Versão instalada globalmente (npm)

```bash
npm ls -g @automagik/genie pgserve 2>&1
```

### 2.3 Cache do bun (mesmo sem instalação global, o cache basta para comprometer)

```bash
ls ~/.bun/install/cache/@automagik/ 2>/dev/null | grep -E "genie@4\.260421\.(3[3-9]|40)"
ls ~/.bun/install/cache/ 2>/dev/null | grep -E "pgserve@1\.1\.(1[1-4])"
ls ~/.cache/.bun/install/cache/@automagik/ 2>/dev/null | grep -E "genie@4\.260421\.(3[3-9]|40)"
ls ~/.cache/.bun/install/cache/ 2>/dev/null | grep -E "pgserve@1\.1\.(1[1-4])"
```

As versões maliciosas aparecem como, por exemplo:
```
genie@4.260421.36@@@1
pgserve@1.1.14@@@1
```

### 2.4 IoCs nos arquivos do pacote

Se encontrou alguma versão suspeita no cache, confirme a presença dos arquivos maliciosos:

```bash
# genie — harvester de credenciais + chave RSA pública do atacante
ls ~/.bun/install/cache/@automagik/genie@4.260421.*@@@1/dist/env-compat.cjs 2>/dev/null
ls ~/.bun/install/cache/@automagik/genie@4.260421.*@@@1/dist/public.pem 2>/dev/null

# pgserve — payload TeamPCP
ls ~/.bun/install/cache/pgserve@1.1.1*@@@1/scripts/check-env.js 2>/dev/null

# Caminhos alternativos
ls ~/.cache/.bun/install/cache/@automagik/genie@4.260421.*@@@1/dist/env-compat.cjs 2>/dev/null
ls ~/.cache/.bun/install/cache/.bun/install/cache/pgserve@1.1.1*@@@1/scripts/check-env.js 2>/dev/null
```

> 🚨 **Se qualquer um desses arquivos existir: VOCÊ FOI INFECTADO.** Vá direto para o Passo 3.

### 2.5 Persistência systemd

```bash
systemctl --user status pgmon 2>&1 | head -5
ls -la ~/.config/systemd/user/pgmon.service 2>&1
ls -la /tmp/pglog /tmp/pg_log /tmp/.pg* 2>&1
```

Se `pgmon.service` existir ou `/tmp/pglog` existir: há persistência ativa na máquina.

### 2.6 Persistência Python (.pth injection)

Legítimos em site-packages são apenas `distutils-precedence.pth`, `_virtualenv.pth` e `easy-install.pth`. Qualquer outro `.pth` é suspeito:

```bash
python3 -c "import site; print('\n'.join(site.getsitepackages()))" 2>/dev/null | while read d; do
  ls "$d"/*.pth 2>/dev/null
done

# Procurar strings associadas ao TeamPCP
python3 -c "import site; print('\n'.join(site.getsitepackages()))" 2>/dev/null | while read d; do
  grep -l -E "pgserve|canister|icp0|api-monitor" "$d"/*.pth 2>/dev/null
done
```

### 2.7 Conexões ativas com C2

```bash
ss -tnp 2>/dev/null | grep -iE "api-monitor|icp0|tdtqy|cjn37|143\.198\.237\.25"
```

> 🚨 **Se aparecer qualquer resultado: a máquina está exfiltrando agora.** Desconecte da rede antes de seguir.

---

## 3. Passo 2 — Interpretar o resultado

| Situação | Veredicto | Ação |
|----------|-----------|------|
| Nenhuma versão maliciosa no cache, nenhum IoC | **CLEAN** | Vá direto para o Passo 4 (prevenção) |
| Versão maliciosa no cache, mas `env-compat.cjs`/`check-env.js` ausentes | **OBSERVADO** | Cache presente mas postinstall pode não ter rodado — trate como **INFECTADO** por precaução (Passo 3) |
| `env-compat.cjs`, `public.pem` ou `check-env.js` presentes | **INFECTADO** | Execute o Passo 3 completo |
| `pgmon.service` ativo ou conexão C2 detectada | **INFECTADO ATIVO** | Desconecte a rede **imediatamente**, depois Passo 3 |

---

## 4. Passo 3 — Remediação (apenas se INFECTADO)

Execute na ordem. Não pule etapas.

### 4.1 Remover persistência

```bash
# Systemd
systemctl --user stop pgmon 2>/dev/null
systemctl --user disable pgmon 2>/dev/null
rm -f ~/.config/systemd/user/pgmon.service
rm -f /tmp/pglog /tmp/pg_log
systemctl --user daemon-reload

# .pth suspeitos (se encontrados no 2.6)
# Remover manualmente os arquivos suspeitos identificados
```

### 4.2 Purgar cache malicioso do bun

```bash
# genie — versões maliciosas 4.260421.33 a 4.260421.40
for v in 33 34 35 36 37 38 39 40; do
  rm -rf ~/.bun/install/cache/@automagik/genie@4.260421.${v}@@@1
  rm -rf ~/.cache/.bun/install/cache/@automagik/genie@4.260421.${v}@@@1
done

# pgserve — versões maliciosas 1.1.11 a 1.1.14
for v in 11 12 13 14; do
  rm -rf ~/.bun/install/cache/pgserve@1.1.${v}@@@1
  rm -rf ~/.cache/.bun/install/cache/pgserve@1.1.${v}@@@1
done

# Verificar que limpou
ls ~/.bun/install/cache/@automagik/ 2>/dev/null | grep -E "genie@4\.260421"
ls ~/.bun/install/cache/ 2>/dev/null | grep -E "pgserve@1\.1\.1[1-4]"
ls ~/.cache/.bun/install/cache/@automagik/ 2>/dev/null | grep -E "genie@4\.260421"
ls ~/.cache/.bun/install/cache/ 2>/dev/null | grep -E "pgserve@1\.1\.1[1-4]"
```

Nenhuma saída = limpo.

### 4.3 Reinstalar versões limpas

```bash
bun install -g @automagik/genie@4.260422.4
bun install -g pgserve@1.1.10
```

### 4.4 Rotacionar TODAS as credenciais

> 🔥 **Este é o passo mais importante.** Qualquer credencial presente na máquina no momento da instalação foi exfiltrada. Rotacionar = revogar a existente e emitir uma nova.

**npm**
```bash
cat ~/.npmrc  # ver token atual
# Rotacionar em: https://www.npmjs.com/settings/<user>/tokens
# Atualizar ~/.npmrc com o novo token (escopo mínimo, 2FA obrigatório)
```

**GitHub CLI / PAT**
```bash
cat ~/.config/gh/hosts.yml  # ver contas logadas
# Rotacionar em: https://github.com/settings/tokens
gh auth login  # re-autenticar após revogar
```

**Chaves SSH**
```bash
ls -la ~/.ssh/id_*
# Gerar nova chave
ssh-keygen -t ed25519 -C "seu@email.com" -f ~/.ssh/id_ed25519_new
# Adicionar nova chave pública em todos os servidores/GitHub
# Remover chave comprometida de todos os authorized_keys
# Substituir ~/.ssh/id_ed25519 pela nova
```

> 💡 **Lição aprendida da nossa investigação:** hosts clonados a partir de um mesmo template podem compartilhar o mesmo par de chaves. Se esse for o seu caso, rotacionar em um host não basta — precisa gerar chaves únicas em cada host e atualizar `authorized_keys` em toda a frota.

**AWS**
```bash
ls ~/.aws/credentials
# Rotacionar em: AWS Console → IAM → Access Keys
aws sts get-caller-identity  # verificar que novas creds estão ativas
```

**GCP**
```bash
ls ~/.config/gcloud/
gcloud auth revoke --all
gcloud auth login
```

**Azure**
```bash
ls ~/.azure/
az logout
az login
# Rotacionar service principals em: portal.azure.com → App registrations → Certificates & secrets
```

**Kubernetes**
```bash
# Rotacionar tokens de service account
# Rotacionar kubeconfig e contextos com acesso a produção
cat ~/.kube/config | grep -E "certificate-authority-data|token"
```

**Docker registry**
```bash
cat ~/.docker/config.json
# Rotacionar credenciais de cada registry (Docker Hub, ECR, GCR, GHCR, OCIR, etc.)
```

**Arquivos `.env`**
```bash
# Encontrar todos os .env no workspace
find ~/workspace ~ -maxdepth 5 -name ".env*" -not -path "*/node_modules/*" 2>/dev/null | head -50
# Para cada um: rotacionar todas as chaves/tokens que ele contém
```

**LLM API keys**
- Anthropic: https://console.anthropic.com → API Keys → revogar e emitir nova
- OpenAI: https://platform.openai.com/api-keys → revogar e emitir nova
- Google: https://aistudio.google.com/apikey → revogar e emitir nova
- Verifique o faturamento das últimas 72h para identificar uso anômalo.

**Carteiras crypto (crítico)**

Se MetaMask, Phantom, Exodus, Atomic ou qualquer carteira estava instalada na máquina: **trate a seed phrase como comprometida**. Em um dispositivo **limpo**:

1. Gere uma nova seed phrase
2. Mova todos os fundos para a nova carteira imediatamente
3. Revogue approvals ativas (use https://revoke.cash ou equivalente)

Roubos de carteira são **irreversíveis**. Não existe recuperação.

**Chaves privadas TLS**

Se você hospeda serviços HTTPS com chaves no disco, rotacione os certificados e chaves privadas.

### 4.5 Se você tem permissão de publish no npm

O worm pode ter utilizado seu token para republicar pacotes maliciosos em seu nome. Verifique:

```bash
# Listar versões publicadas recentemente de cada pacote seu
npm view <seu-pacote> versions --json | tail -10
npm view <seu-pacote> time --json | tail -20
```

Se aparecerem versões inesperadas entre **2026-04-21 e 2026-04-23**:

```bash
npm unpublish <pacote>@<versao>  # remove a versão contaminada (se dentro da janela de 72h)
npm deprecate <pacote>@<versao> "Malicious — CanisterWorm supply-chain attack"
```

Notifique o npm Security: `security@npmjs.com` e, se possível, abra um Security Advisory no GitHub (`GHSA`).

### 4.6 Preservar evidências (opcional, recomendado)

Antes de destruir tudo, se tiver como, preserve:
- Cópia dos arquivos maliciosos identificados no Passo 2 (`env-compat.cjs`, `public.pem`, `check-env.js`)
- Logs de egress da máquina no período 2026-04-21 a 2026-04-22
- Saída de `ss -tnp`, `journalctl --user -u pgmon`, `last`, `who`

Isso ajuda análise forense e atribuição.

---

## 5. Passo 4 — Prevenção (todos os usuários, infectados ou não)

### 5.1 Pinar versões no `package.json`

Nunca use `latest` para pacotes de supply-chain sensível. Use versões explícitas:

```json
{
  "dependencies": {
    "@automagik/genie": "4.260422.4",
    "pgserve": "1.1.10"
  }
}
```

### 5.2 Desabilitar `postinstall` em CI/CD

```bash
npm config set ignore-scripts true
# ou
bun install --ignore-scripts
```

Para desenvolvimento local onde scripts são necessários, avalie ferramentas como `@lavamoat/allow-scripts` para controle granular.

### 5.3 Revisar mecanismos de auto-update

Muitas ferramentas têm auto-update (`genie-update-check.sh`, cron jobs, tmux status hooks etc.). Auto-update **foi o vetor primário de infecção em larga escala** — a máquina instalou sozinha sem ação do usuário. Verifique:

```bash
crontab -l | grep -E "update|genie|pgserve"
systemctl --user list-timers | grep -E "update|genie"
tmux show-options -g status-right 2>/dev/null | grep update
```

Se encontrar: pinar na versão limpa conhecida **antes** de reabilitar.

### 5.4 Exigir 2FA + provenance

- Habilite 2FA em toda conta npm e GitHub.
- Use `npm publish --provenance` (GitHub Actions com OIDC).
- Para repositórios críticos, exija assinatura de commits (GPG/Sigstore) e revisão obrigatória antes de merge.

### 5.5 Segregar credenciais de produção

Credenciais de produção **nunca** devem estar em máquinas de desenvolvimento. Use workstations dedicadas, bastions, ou cofres temporários (HashiCorp Vault, Doppler, AWS Secrets Manager com sessões efêmeras).

---

## 6. Referência rápida — Indicadores de Comprometimento (IoCs)

### Arquivos maliciosos

```
~/.bun/install/cache/@automagik/genie@4.260421.<33-40>@@@1/dist/env-compat.cjs
~/.bun/install/cache/@automagik/genie@4.260421.<33-40>@@@1/dist/public.pem
~/.bun/install/cache/pgserve@1.1.<11-14>@@@1/scripts/check-env.js
```

### Infraestrutura C2 (bloquear no perímetro)

| Indicador | Tipo | Observação |
|-----------|------|------------|
| `telemetry.api-monitor.com` | Webhook de exfiltração | Principal endpoint de coleta |
| `143.198.237.25` | IP | Resolução atual do webhook |
| `cjn37-uyaaa-aaaac-qgnva-cai.raw.icp0.io` | ICP canister | C2 secundário |
| `tdtqy-oyaaa-aaaae-af2dq-cai.raw.icp0.io` | ICP canister | C2 secundário |

### Persistência

| Indicador | Tipo |
|-----------|------|
| `~/.config/systemd/user/pgmon.service` | Serviço systemd |
| `/tmp/pglog`, `/tmp/pg_log` | Binários auxiliares |
| `.pth` suspeito em site-packages Python | Persistência TeamPCP |

### Firewall — exemplo (iptables)

```bash
iptables -I OUTPUT -d 143.198.237.25 -j DROP
iptables -I OUTPUT -p tcp --dport 443 -m string --algo bm --string "api-monitor.com" -j DROP
iptables -I OUTPUT -p tcp --dport 443 -m string --algo bm --string "icp0.io" -j LOG --log-prefix "[CANISTERWORM-C2] "
```

Em Sophos, OPNsense, pfSense ou similares, crie um grupo `CanisterWorm-C2` com os IPs/hosts acima e uma regra de bloqueio em **posição topo**, com logging habilitado.

---

## 7. Checklist de um olhar (imprima e cole no monitor)

- [ ] Verifiquei cache bun e npm — nenhuma versão da tabela 1.2 presente
- [ ] Verifiquei `env-compat.cjs`, `public.pem`, `check-env.js` — ausentes
- [ ] Verifiquei `pgmon.service` e `/tmp/pglog` — ausentes
- [ ] Verifiquei `.pth` Python — apenas legítimos
- [ ] Verifiquei conexão ativa C2 — nenhuma
- [ ] Se infectado: rotacionei npm, GitHub, SSH, AWS, GCP, Azure, kubeconfig, Docker
- [ ] Se infectado: rotacionei todas as LLM keys e revoguei sessões ativas
- [ ] Se infectado: tratei seed phrases crypto como comprometidas
- [ ] Pinnei versões limpas no `package.json`
- [ ] Desabilitei auto-update até validar a fonte
- [ ] Bloqueei IoCs no meu perímetro

---

## 8. Contato e reporte

| Canal | E-mail | Para quê |
|-------|--------|----------|
| DPO Namastex (Cezar Vasconcelos) | `dpo@khal.ai` | Questões de privacidade e LGPD |
| Canal de segurança e incidentes | `privacidade@namastex.ai` | Relatar impacto, pedir ajuda, compartilhar IoCs |
| Canal direto CTO | `cezar@namastex.ai` | Questões técnicas críticas |

**SLA de resposta:** 2 horas em horário comercial (UTC-3).

Se você foi afetado pelo incidente e precisa de ajuda para executar remediação, escreva para `privacidade@namastex.ai`. Apoiamos com orientação sem custo, dentro do razoável.

Reportes privados de segurança relacionados a qualquer pacote Namastex: `privacidade@namastex.ai` (PGP disponível sob solicitação).

---

## 9. Referências externas

- [Socket.dev — Namastex npm packages compromised: CanisterWorm](https://socket.dev/blog/namastex-npm-packages-compromised-canisterworm)
- [BleepingComputer — New npm supply-chain attack self-spreads](https://www.bleepingcomputer.com/news/security/new-npm-supply-chain-attack-self-spreads-to-steal-auth-tokens/)
- [Endor Labs — CanisterWorm analysis](https://www.endorlabs.com/learn/canisterworm)
- [Kodem Security — Compromised npm publisher](https://www.kodemsecurity.com/resources/canisterworm-compromised-npm-publisher-enables-install-time-supply-chain-attack)
- [CSO Online — Malicious pgserve/automagik developer tools](https://www.csoonline.com/article/4162257/malicious-pgserve-automagik-developer-tools-found-in-npm-registry-2.html)
- [The Register — Another npm supply-chain attack](https://www.theregister.com/2026/04/22/another_npm_supply_chain_attack/)

---

## 10. Histórico de revisões

| Data | Versão | Mudança |
|------|--------|---------|
| 2026-04-23 | 1.0 | Publicação inicial consolidada pós-investigação |

---

*Documento mantido por Cezar Vasconcelos — DPO e CTO, Namastex Labs Serviços em Tecnologia Ltda.*
*Distribuição livre. Redistribuição encorajada. Atribuição apreciada.*
