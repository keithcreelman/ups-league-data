# ups-league-data
Public JSON data exports for the UPS Salary Cap Dynasty League (MYM, extensions, contracts, history).

## MFL homepage message
- Public URL (GitHub Pages): https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html
- Preferred embed: in MFL `Setup → Appearance → Front Office Home Page Message`, switch to HTML/source view and paste:
  ```html
  <iframe src="https://keithcreelman.github.io/ups-league-data/mfl_hpm16_contractcommandcenter.html" style="width:100%; height:1400px; border:0;" loading="lazy"></iframe>
  ```
- If the iframe is blocked by MFL, copy the raw HTML from `mfl_hpm16_contractcommandcenter.html` in this repo and paste it directly into the message editor.
- Cache-busting: both CSS/JS links use `?v=20260204e`; bump that token whenever you update `ccc.css` or `ccc.js` so browsers pick up the latest build. GitHub Pages updates a few minutes after each push to `main`.
