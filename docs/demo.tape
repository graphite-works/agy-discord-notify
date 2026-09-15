Output docs/demo.gif

Set FontSize 18
Set Width 1200
Set Height 500
Set Padding 40
Set Theme "Dracula"

Type "# 1. Basic message to the default channel"
Enter
Sleep 1s
Type "node ~/.gemini/config/skills/discord-notify/discord_send.js 'Deploy completed successfully!'"
Sleep 500ms
Enter
Sleep 2s
Enter

Type "# 2. Piping output directly into Discord"
Enter
Sleep 1s
Type "npm test 2>&1 | node ~/.gemini/config/skills/discord-notify/discord_send.js --username 'Test Runner'"
Sleep 500ms
Enter
Sleep 3s
Enter

Type "# 3. Sending an embed"
Enter
Sleep 1s
Type "node ~/.gemini/config/skills/discord-notify/discord_send.js --embed-title 'Build Passed' --embed-color '#57F287' 'All tests passed'"
Sleep 500ms
Enter
Sleep 3s
