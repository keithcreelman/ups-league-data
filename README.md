# ups-league-data
Public JSON data exports for the UPS Salary Cap Dynasty League (MYM, extensions, contracts, history).

## MFL homepage message
- Public URL (GitHub Pages): https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html
- Preferred embed: in MFL `Setup → Appearance → Front Office Home Page Message`, switch to HTML/source view and paste:
  ```html
  <iframe src="https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html" style="width:100%; height:1400px; border:0;" loading="lazy"></iframe>
  ```
- If the iframe is blocked by MFL, copy the raw HTML from `mfl_hpm16_contractcommandcenter.html` in this repo and paste it directly into the message editor.
- Cache-busting: CSS/JS links use `?v=` query tokens; bump them whenever you update `ccc.css` or `ccc.js` so browsers pick up the latest build. GitHub Pages updates a few minutes after each push to `main`.

## GitHub-based MYM JSON refresh
- Workflow: `.github/workflows/refresh-mym-dashboard.yml`
- Trigger options:
  - manual (`workflow_dispatch`)
  - repository dispatch (`refresh-mym-json`)
  - hourly schedule at minute 20
- Required repository secrets:
  - `MFL_COOKIE` (commissioner cookie value or full `MFL_USER_ID=...`)
  - `MFL_LEAGUE_ID` (e.g., `74598`)
- Optional repository secret:
  - `MFL_YEAR` (override dynamic year selection)
- Dynamic year rule (if `MFL_YEAR` is not set):
  - on/after March 1: use current year
  - before March 1: use prior year
- In-app `Roster Refresh` button:
  - queues `repository_dispatch` through the Cloudflare Worker endpoint `/refresh-mym-json`
  - requires worker secret `GITHUB_PAT` (a GitHub token with `repo` access)
  - optional worker vars: `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`
