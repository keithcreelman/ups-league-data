MFL Scheduler (macOS launchd)

This folder contains launchd jobs to run ETL refreshes at different times:

- `com.keith.mfl.rosterscurrent.daily.plist`: daily at 12:05 AM local time
- `com.keith.mfl.rostersweekly.inseason.tuesday.plist`: every Tuesday at 12:20 AM local time
  - Weekly refresh script self-skips outside season window using `leagueevents`

Install / update:

```bash
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "/Users/keithcreelman/Documents/New project/etl/logs"

cp "/Users/keithcreelman/Documents/New project/etl/scheduler/com.keith.mfl.rosterscurrent.daily.plist" \
   "$HOME/Library/LaunchAgents/"
cp "/Users/keithcreelman/Documents/New project/etl/scheduler/com.keith.mfl.rostersweekly.inseason.tuesday.plist" \
   "$HOME/Library/LaunchAgents/"

launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rosterscurrent.daily.plist" 2>/dev/null || true
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.daily.plist" 2>/dev/null || true
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.tuesday.plist" 2>/dev/null || true

launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rosterscurrent.daily.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.keith.mfl.rostersweekly.inseason.tuesday.plist"
```

Check status:

```bash
launchctl print gui/$(id -u)/com.keith.mfl.rosterscurrent.daily
launchctl print gui/$(id -u)/com.keith.mfl.rostersweekly.inseason.tuesday
```
