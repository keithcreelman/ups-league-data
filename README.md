# ups-league-data
Public JSON data exports for the UPS Salary Cap Dynasty League (MYM, extensions, contracts, history).

## MFL homepage message
- Public URL (GitHub Pages): https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html
- Preferred embed: in MFL `Setup → Appearance → Front Office Home Page Message`, switch to HTML/source view and paste:
  ```html
  <div id="cccMount"></div>
  <script src="https://keithcreelman.github.io/ups-league-data/mfl_hpm_embed_loader.js?v=20260209ab"></script>
  ```
- The loader auto-passes `L`, `YEAR`, and `FRANCHISE_ID` from the live MFL page into the iframe.
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

## MYM submission log
- Submission log file: `mym_submissions.json`
- Workflow: `.github/workflows/log-mym-submission.yml`
- Trigger: `repository_dispatch` event type `log-mym-submission` (sent by Worker after successful MYM submit)
- App behavior:
  - third tab `MYM - Submitted` pulls from `mym_submissions.json`
  - includes `Commish Override` and `Override As-Of` columns
  - if a submission exists in salaries but not yet in logs, app shows an `Inferred` row until log arrives
- Backfill helper:
  - `python etl/mfl_etl_full/backfill_mym_submissions_from_dashboard.py --dashboard-path mym_dashboard.json --submissions-path mym_submissions.json --league-id 74598 --commish-override-flag 1 --override-as-of-date "YYYY-MM-DD HH:MM"`

## Restructure submission log
- Submission log file: `restructure_submissions.json`
- Workflow: `.github/workflows/log-restructure-submission.yml`
- Trigger: `repository_dispatch` event type `log-restructure-submission` (sent by Worker after successful restructure import)
- SQLite storage sync:
  - Script: `etl/mfl_etl_full/sync_restructure_submissions_to_db.py`
  - Creates/maintains table: `restructure_submissions`
  - Ingests worker logs from `restructure_submissions.json`
  - Also backfills historical inferred restructures from:
    - `rosters_weekly.contract_info` containing `restruct`
    - `transactions_trades.raw_json/comments` containing `restruct` (adds commentary text)

## Tag tracking (in-season)
- Tracking file: `tag_tracking.json`
- Builder script: `etl/mfl_etl_full/build_tag_tracking.py`
- Current tracking logic:
  - candidates = `rosters_current` rows with `contract_year = 1`, active roster status, and non-rookie contract status
  - scoring rank = sum of `player_weeklyscoringresults.score` for weeks `1..N`, where `N` comes from `metadata_leaguedetails.end_week` (16/17 legacy split)
  - AAV source = `rosters_weekly` week `1` snapshot (`contract_info` AAV parse, fallback salary)
  - tier/bid formulas follow your positional tag matrix
  - non-kickers: if prior AAV is greater than or equal to tier bid, bid becomes prior AAV * 1.10 rounded up to nearest 1,000
  - PK/PN: bid is always prior AAV + 1,000
- Example build:
  ```bash
  python etl/mfl_etl_full/build_tag_tracking.py \
    --db-path /Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db \
    --season 2025 \
    --out-path /Users/keithcreelman/Documents/New\ project/tag_tracking.json
  ```
