# gog setup and authentication

Use this file for account setup, token lifecycle, and Workspace service-account flows.

## 1) Inspect auth state
- `gog auth status`
- `gog auth list`
- `gog auth services`

## 2) Login (interactive OAuth)
- Add account: `gog auth add <email>`
- Open account manager UI: `gog auth manage`
- Remove account: `gog auth remove <email>`

## 3) Multi-account workflows
- List accounts: `gog auth list`
- Per-command account selection: `gog -a user@company.com drive ls`
- Use aliases:
  - `gog auth alias set work user@company.com`
  - `gog auth alias list`
  - `gog auth alias unset work`

## 4) Headless OAuth flow
- Start login from a non-UI environment (returns state/device flow details):
  - `gog auth add user@company.com --no-input`
- Poll completion:
  - `gog auth poll <state>`

## 5) Token management
- List token keys: `gog auth tokens list`
- Export token (sensitive): `gog auth tokens export <key> --out token.json`
- Import token (sensitive): `gog auth tokens import --in token.json`
- Delete token: `gog auth tokens delete <key>`

## 6) OAuth client credentials
- List clients: `gog auth credentials list`
- Set client: `gog auth credentials set <name> --client-id ... --client-secret ...`
- Select client on commands: `gog --client <name> gmail search 'in:inbox'`

## 7) Keyring backend
- Show/set backend: `gog auth keyring [backend]`
- Example backends depend on host support; verify with `gog auth status`.

## 8) Service account (Workspace only)
- Set key for domain-wide delegation:
  - `gog auth service-account set --key /path/key.json --impersonate admin@company.com`
- Check status:
  - `gog auth service-account status`
- Remove key:
  - `gog auth service-account unset`

## 9) Keep-specific service account (Workspace only)
- `gog auth keep --key /path/key.json admin@company.com`

## 10) Recommended auth pattern in agents
1. `gog auth status`
2. choose account (`-a`) and optional `--client`
3. run read checks with `--read-only`
4. run writes with `--dry-run`, then execute after confirmation
