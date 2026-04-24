# Manual de Resposta ao Incidente — CanisterWorm

> **Publicado por:** Namastex Labs Serviços em Tecnologia Ltda — CNPJ 46.156.854/0001-62
> **Versão:** 1.0 · 2026-04-23
> **Classificação:** Público — distribuição livre para quem tenha instalado qualquer versão afetada
> **Páginas relacionadas:** [automagik.dev/security](https://automagik.dev/security) (EN) · [automagik.dev/seguranca](https://automagik.dev/seguranca) (PT)
> **Cópia canônica pública:** [automagik-dev/genie → docs/incident-response/canisterworm.md](https://github.com/automagik-dev/genie/blob/main/docs/incident-response/canisterworm.md)

---

## Sobre este documento

Entre 21 e 22 de abril de 2026, versões maliciosas dos pacotes npm `@automagik/genie` e `pgserve` (publicados pela Namastex Labs) foram carregadas no registro público após o comprometimento de um token de desenvolvedor interno. Assumimos responsabilidade por este incidente. Este manual existe para ajudar **qualquer pessoa ou organização** que tenha instalado as versões afetadas a verificar se foi comprometida e, em caso afirmativo, remediar de forma estruturada.

Se você instalou qualquer versão listada abaixo entre **2026-04-21 e 2026-04-22**, leia este documento do início ao fim antes de executar qualquer comando.

O caminho preferencial agora é começar com `genie sec scan`. Os checks manuais abaixo continuam válidos como confirmação adicional, fallback, ou triagem em hosts onde o CLI não está disponível.

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

Sempre que possível, use também a saída do `genie sec scan` para confirmar quais tipos de material estavam presentes no host. A seção `at-risk local material present on host` não mostra segredos, mas lista os caminhos e artefatos locais que o malware provavelmente teria tentado ler.

---

## 2. Passo 1 — Identificar se você foi afetado

Execute todos os checks abaixo. Anote resultados antes de seguir para o Passo 2.

### Usando `genie sec scan` (recomendado)

Rode primeiro:

```bash
genie sec scan --all-homes --root "$PWD"
```

Se precisar cobrir múltiplos repositórios ou serviços:

```bash
genie sec scan --all-homes --root /srv/app --root /opt/service --root "$PWD"
```

Use `--json` quando quiser arquivar ou automatizar a triagem:

```bash
genie sec scan --json --all-homes --root "$PWD"
```

Como interpretar:

- `LIKELY COMPROMISED` — há sinais de execução, persistência, `.pth`, artefatos de drop, ou processo ativo. Vá direto para o Passo 3.
- `LIKELY AFFECTED` — há versões comprometidas instaladas ou em cache. Trate o host como exposto e siga para o Passo 3.
- `OBSERVED ONLY` — só foram encontradas referências em cache, lockfile, ou log. Ainda assim revise os checks manuais abaixo antes de declarar o host limpo.
- `NO FINDINGS` — não houve evidência específica do incidente dentro do escopo escaneado.

O scanner cobre os mesmos sinais principais deste manual:

- caches npm e bun
- instalações locais e globais
- históricos de shell e arquivos de inicialização
- persistência `systemd`, `cron`, `launchd`, `.pth`
- artefatos temporários e processos vivos
- material local em risco para priorizar rotação

Se o scanner acusar `LIKELY COMPROMISED` ou `LIKELY AFFECTED`, continue com os passos manuais abaixo apenas para coleta complementar e preservação de evidência.

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
| `genie sec scan` retorna `LIKELY COMPROMISED` | **INFECTADO** | Desconecte da rede se possível e execute o Passo 3 completo |
| `genie sec scan` retorna `LIKELY AFFECTED` | **INFECTADO** | Execute o Passo 3 completo |
| `genie sec scan` retorna `OBSERVED ONLY` | **OBSERVADO** | Continue nos checks manuais; se houver dúvida operacional, trate como infectado |
| `genie sec scan` retorna `NO FINDINGS` | **CLEAN provisório** | Se o escopo cobriu todos os homes e roots relevantes, siga para o Passo 4 |
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

Se você executou `genie sec scan`, use a seção `at-risk local material present on host` como checklist para não esquecer nenhuma classe de credencial, carteira, perfil de navegador, ou `.env` local presente no host comprometido.

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

- Anthropic: <https://console.anthropic.com> → API Keys → revogar e emitir nova
- OpenAI: <https://platform.openai.com/api-keys> → revogar e emitir nova
- Google: <https://aistudio.google.com/apikey> → revogar e emitir nova
- Verifique o faturamento das últimas 72h para identificar uso anômalo.

**Carteiras crypto (crítico)**

Se MetaMask, Phantom, Exodus, Atomic ou qualquer carteira estava instalada na máquina: **trate a seed phrase como comprometida**. Em um dispositivo **limpo**:

1. Gere uma nova seed phrase
2. Mova todos os fundos para a nova carteira imediatamente
3. Revogue approvals ativas (use <https://revoke.cash> ou equivalente)

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
- [ ] Rodei `genie sec scan --all-homes --root <repo>` e revisei o veredicto
- [ ] Revisei `at-risk local material present on host` para priorizar rotação
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
| DPO Namastex (Cezar Vasconcelos) | `dpo@namastex.ai` | Questões de privacidade e LGPD |
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
| 2026-04-24 | 1.1 | Adicionado operator playbook em inglês (§11) com árvore de decisão de três ramos, escalations e template de post-mortem |

---

## 11. Operator playbook (English) — three-branch decision tree

The preceding sections are the public advisory for any operator or organization that installed a compromised version. The following section is the **cold-runnable operator playbook** tied to `genie sec scan` status bands. Use it when you already have `@automagik/genie` on the host and you need a step-by-step remediation recipe that matches exactly what the CLI is about to ask of you.

### 11.1 When to use this playbook

Use this playbook when **any** of the following is true:

- `genie sec scan` returned `LIKELY COMPROMISED`, `LIKELY AFFECTED`, or `OBSERVED ONLY`.
- A host ran `@automagik/genie` versions `4.260421.33` through `4.260421.40`, or `pgserve` `1.1.11`–`1.1.14`, between **2026-04-21 and 2026-04-22**.
- An unexpected `pgmon.service`, `/tmp/pglog`, or suspicious `.pth` file appeared on disk.
- Egress to `telemetry.api-monitor.com`, `143.198.237.25`, or any `*.raw.icp0.io` was logged.

### 11.2 Scanner output → decision tree

`genie sec scan` emits a status band at the top of its report. That band picks the branch below.

| Scanner status | Branch | Severity |
|----------------|--------|----------|
| `LIKELY COMPROMISED` | [§11.3 LIKELY COMPROMISED](#113-likely-compromised--full-remediation) | Active compromise evidence (execution, persistence, live process) |
| `LIKELY AFFECTED` | [§11.4 LIKELY AFFECTED](#114-likely-affected--purge--rescan--rotate) | Malicious versions installed or cached; postinstall may have run |
| `OBSERVED ONLY` | [§11.5 OBSERVED ONLY](#115-observed-only--clear--rescan) | Cache/lockfile/log references; no execution evidence |
| `NO FINDINGS` | Stop — pin versions, enable `ignore-scripts`, keep monitoring | None in scope |

> **Non-negotiable first step for any branch:** verify the CLI you are about to trust is genuine. Run `genie sec verify-install` **before** any `remediate`, `restore`, or `rollback` invocation. If that call cannot return exit `0`, read [§11.7 Escalation — `--unsafe-unverified`](#117-escalation----unsafe-unverified) before touching the host.

### 11.3 LIKELY COMPROMISED — full remediation

**Preconditions:** `genie sec scan` returned `LIKELY COMPROMISED`. A live process, persistence unit, or dropped payload was detected. Assume the host is exfiltrating or about to exfiltrate.

#### Step 1 of 7 — Snapshot live processes (evidence preservation)

Before any kill action, capture the live state of every PID the scanner flagged. This output is the forensic baseline for the post-mortem.

```bash
# Replace <pid-from-findings> with each PID from the scan JSON report:
#   scan_id=$(genie sec scan --json --all-homes --root "$PWD" | jq -r '.scan_id')
#   jq -r '.findings[] | select(.category=="live_process") | .pid' \
#     "$GENIE_HOME/sec-scan/$scan_id/report.json"
ps -o pid=,comm=,args= -p <pid-from-findings>

# Archive the full process table too, in case the scanner missed a child:
ps -eo pid,ppid,user,etime,comm,args > /tmp/ps-snapshot-$(date -u +%Y%m%dT%H%M%SZ).txt
```

#### Step 2 of 7 — Block egress to known C2 hosts

CanisterWorm exfiltrates over HTTPS to `telemetry.api-monitor.com`, `143.198.237.25`, and multiple `*.raw.icp0.io` ICP canisters. Block at the host level before scanning.

**Linux — iptables**

```bash
iptables -I OUTPUT -d 143.198.237.25 -j DROP
iptables -I OUTPUT -p tcp --dport 443 -m string --algo bm --string "api-monitor.com" -j DROP
iptables -I OUTPUT -p tcp --dport 443 -m string --algo bm --string "icp0.io" -j LOG --log-prefix "[CANISTERWORM-C2] "
iptables -I OUTPUT -p tcp --dport 443 -m string --algo bm --string "icp0.io" -j DROP
```

**macOS — pf**

```bash
cat >/etc/pf.anchors/canisterworm <<'EOF'
block drop out quick to 143.198.237.25
block drop out quick proto tcp to any port 443 \
  host { "telemetry.api-monitor.com", "cjn37-uyaaa-aaaac-qgnva-cai.raw.icp0.io", \
         "tdtqy-oyaaa-aaaae-af2dq-cai.raw.icp0.io" }
EOF
echo 'anchor "canisterworm"' >> /etc/pf.conf
echo 'load anchor "canisterworm" from "/etc/pf.anchors/canisterworm"' >> /etc/pf.conf
pfctl -f /etc/pf.conf -e
```

**Windows — netsh advfirewall**

```powershell
netsh advfirewall firewall add rule name="CanisterWorm-C2-IP"     dir=out action=block remoteip=143.198.237.25
# Domain-based blocking on Windows requires a WFP filter or upstream DNS sinkhole —
# if your fleet uses a DNS RPZ, push telemetry.api-monitor.com, cjn37-uyaaa-aaaac-qgnva-cai.raw.icp0.io,
# and tdtqy-oyaaa-aaaae-af2dq-cai.raw.icp0.io there.
```

#### Step 3 of 7 — Verify the CLI and run an authoritative scan

`genie sec verify-install` must return exit `0` before you trust the binary. If it does not, see [§11.7](#117-escalation----unsafe-unverified).

```bash
# Exit 0 = signature + provenance both pass against the pinned identity.
genie sec verify-install

# Full scan, persisted JSON report, all home directories, filesystem root.
# GENIE_SEC_SCAN_DISABLED must be unset for this call.
unset GENIE_SEC_SCAN_DISABLED
genie sec scan --all-homes --root / --json
```

Capture the `scan_id` from the output — every subsequent step references it.

#### Step 4 of 7 — Generate a remediation plan, review, apply

`genie sec remediate` is dry-run by default. Generate the plan, read it, then apply.

```bash
SCAN_ID=<paste-scan-id-from-step-3>

# Dry run — materializes a frozen plan manifest.
genie sec remediate --dry-run --scan-id "$SCAN_ID"

# Review the plan: every action class is listed with the target and exit criteria.
cat "$GENIE_HOME/sec-scan/$SCAN_ID/plan.json" | jq '.actions[] | {type, target, reason}'

# Apply — typed per-action consent is required interactively.
genie sec remediate --apply --plan "$GENIE_HOME/sec-scan/$SCAN_ID/plan.json"
```

If `--apply` aborts partway through, resume with:

```bash
genie sec remediate --resume "$GENIE_HOME/sec-scan/$SCAN_ID/resume.json"
```

If `--apply` completed but broke something, see [§11.6 Escalation — rollback](#116-escalation--rollback).

#### Step 5 of 7 — Rotate credentials in priority order

Any credential the host could read at install time was exfiltrated. Rotation = **revoke the old, issue the new**. Order matters.

| # | Target | Rotate URL | Verification |
|---|--------|------------|--------------|
| 1 | npm token | <https://www.npmjs.com/settings/~/tokens> | `npm whoami` with new token |
| 2 | GitHub PAT + gh CLI | <https://github.com/settings/tokens> | `gh auth status` |
| 3 | AWS access keys | AWS IAM Console | `aws sts get-caller-identity` |
| 4 | GCP | `gcloud auth revoke --all && gcloud auth login` | `gcloud auth list` |
| 5 | Azure | `az logout && az login` + rotate service principals | `az account show` |
| 6 | Kubernetes | Rotate service-account tokens + kubeconfig contexts | `kubectl auth whoami` |
| 7 | Docker registries | <https://hub.docker.com/settings/security> (and ECR/GCR/GHCR) | `docker login <registry>` |
| 8 | AI provider keys (Anthropic / OpenAI / Google) | Provider console | Audit billing last 72h |
| 9 | Crypto wallets | New seed on a clean device; move funds | revoke.cash approvals audit |
| 10 | TLS private keys on host | Re-issue via your CA | Verify cert chain on endpoint |

`genie sec remediate --apply` emits a per-host rotation checklist at the end of its run; the table above is the fleet-level order across hosts.

#### Step 6 of 7 — Rebuild image or restore from pre-compromise snapshot

```bash
# Preferred: restore from a snapshot/image predating 2026-04-21.
zfs list -t snapshot | awk '$1 ~ /@2026-04-2[01]/'
aws ec2 describe-snapshots --owner-ids self --filters Name=start-time,Values=2026-04-20*
```

If no clean snapshot exists: re-provision the host from a fresh image, install `@automagik/genie` from the current stable line, run `genie sec verify-install`, and restore workload state from your backup channel (not from the compromised host).

#### Step 7 of 7 — Write the post-mortem

Use the template in [§11.8 Post-mortem template](#118-post-mortem-template). Paste the `scan_id` from Step 3; the audit log under `$GENIE_SEC_AUDIT_LOG` contains the full action trail keyed off that id.

### 11.4 LIKELY AFFECTED — purge → rescan → rotate

**Preconditions:** `genie sec scan` returned `LIKELY AFFECTED`. Malicious versions were installed or cached. Postinstall execution cannot be ruled out, but no live process, persistence unit, or dropped payload was observed.

#### Step 1 of 4 — Purge caches and installed packages

```bash
# bun cache — versions 4.260421.33 through 4.260421.40
for v in 33 34 35 36 37 38 39 40; do
  rm -rf ~/.bun/install/cache/@automagik/genie@4.260421.${v}@@@1
  rm -rf ~/.cache/.bun/install/cache/@automagik/genie@4.260421.${v}@@@1
done

# pgserve — 1.1.11 through 1.1.14
for v in 11 12 13 14; do
  rm -rf ~/.bun/install/cache/pgserve@1.1.${v}@@@1
  rm -rf ~/.cache/.bun/install/cache/pgserve@1.1.${v}@@@1
done

# Globally installed copies
bun pm uninstall -g @automagik/genie pgserve 2>/dev/null || true
npm uninstall -g @automagik/genie pgserve 2>/dev/null || true
```

#### Step 2 of 4 — Re-scan, confirm delta is empty

```bash
genie sec verify-install
genie sec scan --all-homes --root "$PWD" --json > /tmp/rescan.json

# Status MUST now be NO FINDINGS. If it still reports LIKELY AFFECTED:
# a cache entry was missed. Re-run Step 1.
jq -r '.status' /tmp/rescan.json
```

#### Step 3 of 4 — Install clean versions

```bash
bun install -g @automagik/genie@^4.260422.4
bun install -g pgserve@^1.1.10
```

#### Step 4 of 4 — Rotate credentials that were live during the compromise window

Rotate every credential that was **in environment or on disk between 2026-04-21 and 2026-04-22**. If you cannot bound the window, rotate everything in the [§11.3 Step 5 table](#step-5-of-7--rotate-credentials-in-priority-order).

### 11.5 OBSERVED ONLY — clear → rescan

**Preconditions:** `genie sec scan` returned `OBSERVED ONLY`. Only passive references (cache index without unpacked contents, lockfile entries, shell history) were found. No dropped payload, no persistence, no live process.

#### Step 1 of 3 — Clear the referenced cache / history entries

```bash
# bun cache (even if empty manifests, clear the names)
rm -rf ~/.bun/install/cache/@automagik/genie@4.260421.*@@@1
rm -rf ~/.bun/install/cache/pgserve@1.1.1[1-4]@@@1

# Shell history entries mentioning compromised versions
for h in ~/.bash_history ~/.zsh_history; do
  [ -f "$h" ] || continue
  cp -a "$h" "${h}.pre-canisterworm.bak"
  grep -vE 'genie@4\.260421\.(3[3-9]|40)|pgserve@1\.1\.(1[1-4])' "${h}.pre-canisterworm.bak" > "$h" || true
done
```

#### Step 2 of 3 — Re-scan to confirm

```bash
genie sec scan --all-homes --root "$PWD" --json > /tmp/rescan.json
# Expected: NO FINDINGS.
jq -r '.status' /tmp/rescan.json
```

#### Step 3 of 3 — Do not rotate credentials yet

`OBSERVED ONLY` means we have no evidence the postinstall script executed. **Skip credential rotation** unless later evidence (shell history showing an install + invoke, auditd `execve` of `node scripts/env-compat.cjs`, egress logs to a C2 host) surfaces. If any of those appears, re-classify as `LIKELY AFFECTED` and run §11.4.

### 11.6 Escalation — rollback

Use `genie sec rollback <scan_id>` when `genie sec remediate --apply` completed but broke something on the host. Rollback walks the audit log in reverse, restoring every quarantined item to its original path with sha256-verified content.

**When to reach for this:** a service fails to start after remediation, a legitimate config file was quarantined, a dependency your application needs is gone. Rollback is safe — it only touches items the audit log recorded.

```bash
# Bulk rollback: walks $GENIE_SEC_AUDIT_LOG in reverse for this scan_id.
genie sec rollback "$SCAN_ID"

# Per-item: if you only need to restore a specific quarantine id.
genie sec quarantine list
genie sec restore <quarantine-id>
```

### 11.7 Escalation — `--unsafe-unverified`

`genie sec remediate --apply` refuses to run unless `genie sec verify-install` returned exit `0`. The `--unsafe-unverified <INCIDENT_ID>` flag is the only documented escape hatch. Every invocation is written to `$GENIE_SEC_AUDIT_LOG` with the incident id, the typed ack, and the reason.

#### When `--unsafe-unverified` is legitimate

There are **three** contexts in which `--unsafe-unverified` is a correct operator choice.

**Context 1 — Burned public key / burned signing identity**

A Namastex security officer confirmed the cosign keyless identity is compromised (see [`docs/security/key-rotation.md`](../security/key-rotation.md)). `verify-install` returns exit `3` (signer-identity-mismatch). The host needs remediation now; rotation will take hours.

```bash
# Incident id MUST come from the pinned rotation issue; do not invent one.
genie sec remediate --apply \
  --plan "$GENIE_HOME/sec-scan/$SCAN_ID/plan.json" \
  --unsafe-unverified "SIGNING_CERT_IDENTITY_20260423"
# Typed ack prompt: I_ACKNOWLEDGE_UNSIGNED_GENIE_SIGNING_CERT_IDENTITY_20260423
```

Audit-log verification:

```bash
jq -r 'select(.event=="remediate.apply.start" and .unsafe_unverified != null)' \
  "$GENIE_SEC_AUDIT_LOG"
# Expect a single entry whose incident_id matches the rotation issue number.
```

**Context 2 — CI pre-signing period**

The release channel is older than the `genie-supply-chain-signing` cutover and does not ship a signed tarball. `verify-install` returns exit `5` (no signature material found). Common during staged rollouts between `4.260423.x` and `4.260424.x`.

```bash
genie sec remediate --apply \
  --plan "$GENIE_HOME/sec-scan/$SCAN_ID/plan.json" \
  --unsafe-unverified "PRE_SIGNING_CHANNEL_260423"
# Typed ack prompt: I_ACKNOWLEDGE_UNSIGNED_GENIE_PRE_SIGNING_CHANNEL_260423
```

**Context 3 — Integration test harness**

`scripts/test-runbook.sh` and the CI workflow exercise `remediate --apply` against a fixture on an unsigned development tarball. The `INCIDENT_ID` is a fixed sentinel recognized by the harness.

```bash
genie sec remediate --apply \
  --plan "$FIXTURE_DIR/plan.json" \
  --unsafe-unverified "TEST_HARNESS_CANISTERWORM_FIXTURE" \
  --auto-confirm-from "$FIXTURE_DIR/consent.json"
# Typed ack prompt: I_ACKNOWLEDGE_UNSIGNED_GENIE_TEST_HARNESS_CANISTERWORM_FIXTURE
```

#### When `--unsafe-unverified` is NOT legitimate

- **"It's faster."** The prompt is the point; verification is the contract.
- **"The prompt is annoying."** See above.
- **"I don't have the key locally."** There is no key — the signing identity is a three-value tuple (see [SECURITY.md § Release Signing](../../SECURITY.md#release-signingpinned-identity-cosign-keyless)). If `verify-install` exits `5`, use Context 2.
- **"Our release channel is old."** Upgrade. If that is not possible right now, use Context 2 with the correct release-line identifier.

Any `--unsafe-unverified` invocation whose incident id does not map to one of the three legitimate contexts is treated as an incident of its own by post-hoc review.

### 11.8 Post-mortem template

Copy the block below into your incident channel and fill in every field. The `scan_id` ties it to the persisted scan JSON, the audit log, and the remediation plan manifest.

```markdown
# Post-mortem: CanisterWorm exposure on <host or fleet scope>

## Metadata
- Scan id:          <paste from `genie sec scan --json`>
- Scan bands hit:   LIKELY COMPROMISED / LIKELY AFFECTED / OBSERVED ONLY (delete two)
- Detection time:   <ISO-8601 UTC>
- Containment time: <ISO-8601 UTC>
- Runbook branch:   §11.3 / §11.4 / §11.5

## Exposure
- Affected versions installed: <list @automagik/genie + pgserve versions>
- Install method:              <bun / npm / CI / auto-update>
- Window of exposure:          <from when the compromised version landed to when the host was contained>
- Material at risk:            <paste `at-risk local material present on host` from scan report>

## Actions taken
- Scan report:   $GENIE_HOME/sec-scan/<scan_id>/report.json
- Plan manifest: $GENIE_HOME/sec-scan/<scan_id>/plan.json
- Audit log:     $GENIE_SEC_AUDIT_LOG (filter on scan_id)
- Rollback used? yes / no (if yes, reason)
- --unsafe-unverified used? yes / no (if yes, which legitimate context from §11.7)

## Credential rotation
- npm:        rotated at <time> · verified with `npm whoami`
- GitHub:     rotated at <time> · verified with `gh auth status`
- AWS:        rotated at <time> · verified with `aws sts get-caller-identity`
- GCP:        rotated at <time>
- Azure:      rotated at <time>
- Kubernetes: rotated at <time>
- Docker:     rotated at <time>
- AI keys:    rotated at <time> · 72h billing audit clean? yes / no
- Crypto:     wallets moved to new seed on clean device? yes / no / N/A
- TLS:        certs re-issued? yes / no / N/A

## Timeline
- <ISO>  Scanner flagged host.
- <ISO>  Egress blocked at perimeter.
- <ISO>  `genie sec remediate --dry-run --scan-id ...` reviewed.
- <ISO>  `genie sec remediate --apply ...` completed.
- <ISO>  Credential rotation completed.
- <ISO>  Host rebuilt / snapshot restored.
- <ISO>  Re-scan returned NO FINDINGS.

## Lessons learned
- <what the compromise window cost>
- <what would have shortened detection>
- <what policy/tooling change lands this week>

## Attachments
- Process snapshot: /tmp/ps-snapshot-*.txt
- Re-scan report:   /tmp/rescan.json
- C2 egress logs:   <link>
```

---

*Documento mantido por Cezar Vasconcelos — DPO e CTO, Namastex Labs Serviços em Tecnologia Ltda.*
*Distribuição livre. Redistribuição encorajada. Atribuição apreciada.*
