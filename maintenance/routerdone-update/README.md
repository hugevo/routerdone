# RouterDone Update Rules

Quy tắc cập nhật RouterDone khi upstream 9Router (decolua/9router) ra bản mới.
Làm lại đúng các bước dưới đây mỗi lần update.

## Kiến trúc

RouterDone la public fork cua upstream 9Router (MIT, decolua).
- `src/`, `open-sse/`, `public/`, `package.json`, `configs` = snapshot nguon
  upstream v0.5.8 + tat ca custom patch da apply + rebrand RouterDone.
- `patches/routerdone-custom.patch` = patch chinh (brand + tuy chinh).
- `patches/features/*.patch` = patch tinh nang (RTK, auto-heal, quota,
  observability, model-redirect, stream-fallback, sanitize, normalize,
  GMT+7, compatible-model-selector).
- `Dockerfile` = build standalone tu nguon local (khong clone upstream).
- `maintenance/routerdone-update/` = tap hop quy tac + script update.

## Khi Upstream Co Ban Moi

1. Doc version upstream moi:
   `gh release view --repo decolua/9router --json tagName`
   Fallback neu GitHub API bi rate-limit: `npm view 9router version`
2. Chay script update (xem `sync-routerdone-from-9router.ps1`):
   - Lay latest tu GitHub Releases `decolua/9router` (fallback git tags/npm).
   - Clone upstream version moi ve thu muc tam.
   - Apply `patches/routerdone-custom.patch`.
   - Apply `patches/features/*.patch` theo thu tu (xem PATCH_ORDER.md).
   - Chay rebrand rules (xem REBRAND_RULES.md).
   - Copy nguon da patch + rebrand vao routerdone/src, open-sse, public, ...
   - Cap nhat `package.json` version.
3. Neu `git apply` fail: rebase patch khong trung khop len upstream moi.
   - Mo patch, cap nhat context/hunk cho khop upstream moi.
   - Verify `git apply --check` tren fresh clone.
   - Ghi lai thay doi vao `PATCH_ORDER.md` muc "Rebase History".
4. Chay verify checklist (xem VERIFY_CHECKLIST.md).
5. Khong push public khi chua pass toan bo checklist.


## Sau Khi Update

1. Chay verify checklist.
2. Commit thay doi len branch local.
3. Push len GitHub repo public.
4. Tao GitHub Release +1 patch:

```bash
gh release list --repo thoa100m/routerdone --limit 1
gh release create v0.5.9 --repo thoa100m/routerdone --target main --title "RouterDone v0.5.9" --notes "Upstream 9Router sync + RouterDone rebrand + verify green"
gh release view v0.5.9 --repo thoa100m/routerdone
```

Neu version moi khac `0.5.8`, bump PATCH len `+1` tu tag hien tai.
## Khong Duoc

- Khong copy `.agents/`, `rules/`, `AGENTS.md`, `cloud/`, `skills/`,
  `tester/`, `task-bootstrap-cache-design.txt`, `gitbook/`, `images/`,
  `cli/` tu llmGateway private vao routerdone public.
- Khong giu git history cu.
- Khong hardcode combo ca nhan (vd `gpt-5.5.fallback`). Dung ten trung
  tinh `helper.fallback`, `coding.fallback`, `vision.fallback`.
- Khong hardcode domain/IP/tunnel ca nhan.
- Khong de secret mac dinh trong code (.env.example = placeholder).
- Khong rebrand `9Router`/`9router` trong context lines cua patch
  (chi rebrand trong added lines, giu context khop upstream).
