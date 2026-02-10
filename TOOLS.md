# TOOLS.md - Local Notes

## Messaging — CRITICAL

### WhatsApp via Omni CLI (PRIMARY for notifications)
- **Binary:** `~/.omni/bin/omni` (pointed at repo: `/home/genie/workspace/repos/automagik/omni/packages/cli/src/index.ts`)
- **API:** `https://felipe.omni.namastex.io`
- **Default instance:** `07a5178e-fb07-4d93-885b-1d361fbd5d6b`
- **NEVER use the OpenClaw WhatsApp plugin** — it's disabled. Always use `omni` CLI.
- Skill docs: `/home/genie/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/skills/omni/SKILL.md`

### Key Contacts
- **Felipe:** +5512982298888
- **Cezar:** +555197285829 (GitHub: vasconceloscezar)

### Groups
- **"Genie - The First"** (`120363424660366845@g.us`) — HIGH LEVEL comms with Felipe & Cezar
  - Use for: status updates, PR links, issue notifications, decisions
  - Always include links (PRs, issues) — not just descriptions
  - This is HOME BASE for async communication

### Communication Rules
- **WhatsApp (Omni):** Quick updates, links, notifications, status. Primary channel.
- **Telegram:** Heavy sessions, long-form work, debugging. Secondary.
- **GitHub PRs:** Always add reviewer (vasconceloscezar) + post links to WhatsApp group.

### WhatsApp Scout Agent
- Agent: `whatsapp-scout` — monitors "Genie - The First" group
- Heartbeat: every 10 minutes, Gemini 3 Flash
- Purpose: decide if Genie needs to wake up to respond
- Business hours only (9am-7pm GMT-3)

## Infrastructure

### Omni CLI Quick Ref
```bash
export PATH="$HOME/.omni/bin:$PATH"
omni send --to "+55..." --text "msg"              # DM
omni send --to "...@g.us" --text "msg"            # Group
omni chats list --search "name"                   # Find chats
omni chats messages <chat-id> --limit 10          # Read msgs
omni instances group-create <instance> --subject "Name" --participants "+55..." "+55..."
omni instances groups <instance> --search "name"  # List groups (get JIDs)
omni instances update-picture <instance> --base64 <data>  # Bot profile pic (BROKEN — use API)
omni instances group-update-picture <instance> --group <jid> --base64 <data>  # Group pic (BROKEN — use API)
```

### Profile/Group Picture Update (via API — CLI has a bug)
```bash
# Resize image first (WhatsApp wants small files)
python3 -c "from PIL import Image; img=Image.open('input.png'); img.resize((500,500), Image.LANCZOS).save('small.jpg', 'JPEG', quality=85)"
IMG_BASE64=$(base64 -w0 small.jpg)

# Bot profile pic
curl -s -X PUT "https://felipe.omni.namastex.io/api/v2/instances/$INSTANCE_ID/profile/picture" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"base64\": \"$IMG_BASE64\"}"

# Group pic
curl -s -X PUT "https://felipe.omni.namastex.io/api/v2/instances/$INSTANCE_ID/groups/$GROUP_JID/picture" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"base64\": \"$IMG_BASE64\"}"
```
**Note:** CLI commands exist but fail with "Unable to connect" — use raw API with `x-api-key` header (not `Authorization: Bearer`). Bug reported to Omni.

---

Add whatever helps you do your job. This is your cheat sheet.
