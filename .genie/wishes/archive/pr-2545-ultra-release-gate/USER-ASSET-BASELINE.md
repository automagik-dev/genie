# Read-only user asset baseline

Captured 2026-07-10 after the requested migration. Skill root: `/Users/feliperosa/.agents/skills`; agent root: `/Users/feliperosa/.codex/agents`; selected migrated source list: `/tmp/codex-skills-migration.zMIx5g` directories containing `SKILL.md`. Validation at capture time: 36/36 skill directories passed the Codex skill validator and carried `agents/openai.yaml`; 14/14 agent TOMLs parsed; the seven specialist profiles use `gpt-5.6-sol` with Ultra effort and read-only sandboxing.

Live `genie update` and `genie uninstall` are prohibited during remediation. Tests copy these assets into isolated temporary HOME/CODEX_HOME/GENIE_HOME fixtures. Final QA recomputes the live baseline read-only and requires exact equality.

## Reproduction

For each selected skill directory, enumerate regular files, sort paths with `LC_ALL=C`, serialize each record as `<relative-path><two spaces><file-sha256><newline>`, then SHA-256 that complete byte stream. Agent TOMLs are SHA-256 hashed directly and sorted by filename.

```bash
SKILL_ROOT=/Users/feliperosa/.agents/skills
for d in /tmp/codex-skills-migration.zMIx5g/*; do
  name=${d##*/}; target="$SKILL_ROOT/$name"
  test -f "$target/SKILL.md" || continue
  find "$target" -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    rel=${file#"$target"/}
    printf '%s  ' "$rel"
    shasum -a 256 "$file" | awk '{print $1}'
  done | shasum -a 256
done
for file in /Users/feliperosa/.codex/agents/*.toml; do shasum -a 256 "$file"; done
```

This baseline is immutable during implementation. Final comparison evidence belongs in `REVIEW-DISPOSITION.md`, not here.

## Skills (36)

| Name | Directory digest |
|------|------------------|
| `architecture-ousterhout` | `2978d4eb6b449b15afe7e5007afab32d6b14fa0a9e19b37c83576d5e4ea6649c` |
| `architecture` | `93abef1ee905e5959b1853bc32cf3c6c58052646a8aadb055df2f2398b5a07f3` |
| `brainstorm` | `540a612b7abd63c0af9da1903b7a90026f6214d80e3d9d97f7fc3b5e04a64a6e` |
| `code-quality-hejlsberg` | `57df82ee6b7166fc9ada1d85e918e02ff9609edb81d3a1c99087b504e20fcb9c` |
| `code-quality` | `b943ef69736fc362fd14719fa3071f9d30208d95d2ae29149a8f105768cc016d` |
| `council` | `81ede1b50542fd810cdaf39d6c3fcad6ef599723ae8c938a4bf073881e816fcd` |
| `docs` | `f1b74099155988818ce94dbfd204063a2e2bd3b98d78615287fcd8ad9ed4377d` |
| `dream` | `5a759f09f835ae97cbc3cb0319f75acf58ae8190f7b8de8fe81b8f0a2d799f4f` |
| `dx-docs-procida` | `dcc5078b27ddce476b49a6c19137a34a95d821e85c48219a2c12fba64d88b61e` |
| `dx-docs` | `81adef683e6fcafbbda0ec275a61699181c75bf263a537c8c96080ea4e6c86fc` |
| `fde-engineer` | `0306e7f0dcaab3a5a1b21309389e27d6041f059fa3d02c414e3e374ea115bf0f` |
| `fde-leader` | `d0813c52cd43bf8e526f6ca878a72a47963e74dc260d2fbe33865cba17f8c86f` |
| `fix` | `fd01d3f1f0a5ac199e18bf6d20de5aa8685bc597be18564f5d227518a176582a` |
| `genie-hacks` | `2ae6caccf1f9b2a61fb86845fdc79989fdfdcca2f60e9f78022032c1b715e266` |
| `genie-review` | `304fbc444f39a4ef0bcad69ad6abff0cde084d37d5c2345efdc57fa0ade01e47` |
| `genie` | `885489d629f25fcbb6a08eeea888532774010d616d3dadda13d69bccf2925916` |
| `hermes-pairing` | `6c5890fc3452bbca9d209c53ed52edb8b8cd6af1429f8cde3f7510558b2d0c87` |
| `movecta-access-pack-operations` | `c44bf762c6d1bb4398882b344f9acf21819b40de93a28646734f454b9aed14a0` |
| `omni` | `949440fa81e970733bd4d1d1ce81d45566cc9a62f007c1ece0b4455d91d6a47f` |
| `perf-gregg` | `34c82ff099880b54f4ed3012fa36dd7af52a71be9f3134f2f675feef59a36928` |
| `perf` | `b742ad85298ba850f52710acea94ef32663c45fb914926f566d7e31a15231dce` |
| `pm` | `2c1663491201d991916386c98bb600c580e17b4725420134143b5d7c2a4dc953` |
| `qa-beck` | `f0dd648c16a8afdc071b63659d5b91d19d07cb79ce20bde6d93c11aba9d2c7a5` |
| `qa` | `391c380e8efa38b58f31439a1eb501f68dfd94603212e54fa7d5e02d548c9898` |
| `refine` | `b2bd58238c76288f6a23134b90388156fb1164b5662c937eeeed90efea6be596` |
| `repo-hygiene-chacon` | `c53161268bc4d54f41763b2eb7ef4db77558b6645b7d420e7efb871b0cc15669` |
| `repo-hygiene` | `0617242e852c8bdf68bcae59213820d193dc54cba4a85a795881e84de178c2b7` |
| `report` | `f444f0a4ef0387069ff5469a400f6ea4e704bb151ef92e354756755e4b62a492` |
| `skill-management` | `d03a6a23fc5d69fb87fe2b18aeb68273ef32f36b217e1e711cfb245731142ac1` |
| `specialist-panel` | `f8fef452f497945e54b7e6f14948afe76ef812a08578d885b4fe60ec987f8720` |
| `supply-chain-lorenc` | `ca6f9b148c7def2f3df65bfbd5b8ad7f2316c51b0011db8210110e91e5ebd471` |
| `supply-chain` | `debdf0fb7e24eb649335874bbc7101ae618f41bd627d80b4d25e899ba7d68e1e` |
| `trace` | `04ba7645d3165c9493be18318eab7d41990cea44957c6982bd96f57856b8c568` |
| `wish` | `a398cd6f15cf6006eb0b1049f68228f2b8d4705a27fbf27e2e746699b92f7949` |
| `wizard` | `b49fd74158765d9401fc8864ac768fc00c2e5ef109a6a4afe0dea8b0d89cc45f` |
| `work` | `cf39c77247a2606ff61f2884b7e6761d9361350bab3da6ba871ee54959c68b15` |

## Custom agent TOMLs (14)

| Name | SHA-256 |
|------|----------|
| `architecture-ousterhout.toml` | `80585f60d4e99ac5e80ad5dc5ccb147d9b5e9220ce539a2e6741f74382c58e06` |
| `code-quality-hejlsberg.toml` | `8fca4b0a377af9ab33d6f467d62dce149041391f3c918eae82ace691372ade0b` |
| `dx-docs-procida.toml` | `7e9c20ac8cd52c0a29bf924dd03593234625141e4f6738b91043555cea761304` |
| `genie-engineer-complex.toml` | `62ecc570f1d77783511a9e7f0aa67b3a65d8bba292963409a02c7712c93ebc3b` |
| `genie-engineer-standard.toml` | `dc746813b9b4b6aa984c17fa2fd75d4dbe34eba08494a174c0715da07aa9dd30` |
| `genie-engineer-trivial.toml` | `249deced5a02eb2cbe3303db566992d1336c75d853967f851bf1d0e85b6b0f47` |
| `genie-final-gate.toml` | `10ef070db8aace75bd80ef9e060a6ec601e3768f177fdd843f4db11035738f7e` |
| `genie-fixer.toml` | `b3c1f407d4a3a2cfe204dee7b4a9c038e1a8f4644c446fcfa23f4a681bf0c7b3` |
| `genie-reviewer.toml` | `91f40a07905834716311419375581e3245544a77eac3d93d082842652c6452bf` |
| `genie-scout.toml` | `03a9fb3ca0e5f36c69c8f934d37adce1bae736e4c3895b144a0001ad31b1ba59` |
| `perf-gregg.toml` | `25e2bcbc59b92184f95e8e5eff5b9a0f04782ddbf1298f546a1d3a96a6ca1621` |
| `qa-beck.toml` | `f7e311a811f3e6c2874fa97a27992b2e4fd3a77b1cb2cec6993fcab1904f52e5` |
| `repo-hygiene-chacon.toml` | `00f6d87693bf406f518890ce3e201b79b75fd9367374f8a0a1d17306cd3ef0c6` |
| `supply-chain-lorenc.toml` | `29ed3ca29f67023f0c37b681456f31b16adc57e707c016f25a2353770f7849b0` |
