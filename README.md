# 🍡 Mochi Vault

A small, always-on-top desktop widget that replaces Sticky Notes for passwords, notes and a daily to-do log.

## Run

- Double-click **`Mochi Vault.vbs`**, or run `npm start`.
- **Ctrl+Alt+M** shows or hides the widget from anywhere.
- **Ctrl+Alt+Space** opens quick search from anywhere (see below).
- **Ctrl+Alt+V** types your VPN login into FortiClient (see below).
- **⋯ → Start with Windows** opens Mochi when you sign in. If you move the `mochi-vault` folder, turn it on again.

## Tabs

| Tab | What it does |
|---|---|
| 🔑 Keys | Masked passwords. Click a value or 📋 to copy, 👁 to show it for 10 s. Add, edit, delete, ⭐ pin, drag to reorder. Give each key any tags you like. |
| 🔗 Links | One card per project, with a tag on each link. A dot shows whether each site is up. Filter by tag, click to open in the browser, 📋 to copy. Stored in `notes.md` under `# Links`. |
| ✅ Today | Daily to-dos. Unfinished items carry over each morning. 📋 Standup copies a Yesterday/Today summary. |
| 📝 Notes | Plain notes stored in `notes.md`. |

Click **–** to shrink the widget into a mascot. Click the mascot to open it again, or drag it to move it. **⋯ → 🐾 Mascots** adds your own pictures (PNG, GIF or WebP, 5 MB max; animated GIFs move), switches between them, or deletes them. Pictures are stored in `%APPDATA%\mochi-vault\mascots`.

The mascot reacts too. It falls asleep with a 💤 after 5 minutes without mouse or keyboard, and bounces when it wakes, when the VPN drops, and when you finish your last task. While Mochi is locked, the drawn mochi closes its eyes and pictures show a 🔒.

**⋯ → 💧 Water reminder** sets how often the mascot reminds you to sip (45 minutes by default, or Off). It bounces, shows a 💧 and says your message in a speech bubble (`จิบน้ำหน่อยงับ` by default), then repeats every 5 minutes. Change the words in the same dialog, and use **Try it** to see them. Click the mascot, the bubble, or the 💧 in the title bar once you have had a sip. While the 💧 shows, clicking the mascot does not open the widget. There are no reminders while the mascot is asleep.

**⋯ → ✏️ Rename** changes the name in the title bar and on the taskbar. Your data stays where it is.

Shortcuts: **Ctrl+F** search keys (Enter copies the first match's password), **Ctrl+N** new key or note, **Esc** closes dialogs.

## Tags

Tags are yours to choose, like `Work`, `Bank` or `PROD`. When you edit a key, click a tag to turn it on or off, or type a new one and press Enter. A tag leaves the list once no key or link uses it. On a link, the tag is its label, and the filter buttons on the 🔗 Links tab come from the tags you use. PROD, UAT, DEV and SIT keep their fixed colors, and other tags get their own.

## Link status

Each link on the 🔗 Links tab has a dot. Hover over it for the reason.

| Dot | Meaning |
|---|---|
| 🟢 Green | The site answered, even with a login page or 401 |
| 🔴 Red | Server error (5xx), or no answer while the VPN is on |
| ⚪ Grey | No answer while the VPN is off, so this may be normal |

Mochi sends one `HEAD` request per link when you open the tab, at most every 5 minutes. **↻** checks again now. It never sends a login, and it does not check in the background.

## Quick search

Press **Ctrl+Alt+Space** in any app and type a few letters. Every word has to match, so `portal uat` finds the UAT link of Portal.

| Key | On a 🔑 key | On a 🔗 link |
|---|---|---|
| **Enter** | Copy the password | Open it |
| **Shift+Enter** | Copy the username | Copy the link |
| **↑ ↓** | Move through results | |
| **Esc** | Close | |

It works while the widget is hidden or shrunk, and closes when you click away. If Mochi is locked, it asks for your PIN first. Copied passwords follow the same rules as the widget.

## Security

- **Passwords** are stored in `%APPDATA%\mochi-vault\vault.enc`, encrypted with Windows DPAPI. Only your Windows user on this PC can decrypt the file.
- **Copying or revealing** a password needs Windows Hello, or the app PIN when Hello is not set up. It stays unlocked for 15 minutes and locks when the PC locks or sleeps.
- **Two-factor (⋯ → 🔑 Two-factor):** scan the QR with Google Authenticator or any TOTP app, then unlock with the 6-digit code. Your PIN still works as a backup. This is an unlock gate against someone at your desk — like the PIN, it does not encrypt the vault and does not stop malware running as you.
- **Copied passwords** are excluded from Win+V clipboard history and cloud clipboard, and cleared after 30 s.
- **Screen sharing** and screenshots show the widget as blank.
- **Deleted keys** go to Trash (⋯ → Trash) for 30 days. Editing a password keeps the previous one.
- **Backup:** ⋯ → Export backup writes a `.mvault` file encrypted with a master password. Make one: if this PC dies, `vault.enc` can't be recovered.
- The PIN is a speed bump against someone at your unlocked desk, not protection against malware running as you. Keep locking the PC (Win+L).

## Remote Desktop

Keys with **🖥 Remote Desktop server** ticked (on by default when the title or group says RDP or Remote) get a **🖥 Connect** button. List several servers in Host (`srv-uat, srv-prod`) and Mochi asks which one.

Connect needs an unlock. Mochi hands the login to Windows for 60 seconds through the Credential API, starts Remote Desktop, then removes it. It also copies the password, in case a policy blocks saved logins and Windows asks for it. A login you already saved in Windows for that server is used as it is, never replaced or deleted.

## Run a command

A key can hold a shell command (⋯ edit a key → **Run command**). It gets a **▶ Run command** button that opens a new PowerShell window and runs the lines there — handy for starting a project, like:

```
cd C:\Users\you\source\repos\MyApp
git switch my-branch
npm start
```

It needs an unlock first. The command is stored encrypted in the vault, never in `notes.md`. Mochi runs exactly the lines you saved, in a window that stays open, so a long-running `npm start` keeps going and any error stays visible. Only save commands you trust — this runs them on your PC.

## FortiClient VPN

The **VPN** light in the title bar is green when connected and red after a drop, and the shrunk mascot shows a red dot. Click the light to open FortiClient. If you are offline on purpose, **⋯ → 🔌 Hide VPN light** removes the light and the red dot until you show it again. Ctrl+Alt+V still works.

For profiles that do not allow Save Password, tick **🔌 VPN login** on one key. Then click the **Username** box in FortiClient, press **Ctrl+Alt+V**, check the fields, and press Enter yourself.

Mochi types only while FortiClient is the active window, checks again before each step, and never presses Enter, so a misplaced cursor cannot cost a failed login. If the cursor is not in the Username box, the password can land in a visible box, so click there first. If a profile offers **Always Up**, use that instead.

## Import from Sticky Notes

**⋯ → 🗒 Import Sticky Notes** reads both the current and the old Sticky Notes store, one note at a time. Password-looking lines are masked. Use 👁 / 🔒 on a line if the guess is wrong. Tick the lines for one login and send them to 🔑 Key, 🔗 Link or 📝 Note, then repeat until the note is cleared. Lines marked as passwords never go to `notes.md`.

It needs an unlock, and it only reads: your Sticky Notes stay unchanged, so delete them in the Sticky Notes app when you finish. Reviewed notes are remembered, so you can stop and come back later.

## Tests

`npm test` runs the Sticky Notes, Remote Desktop, VPN, Start with Windows, Rename, Quick search, Link status, Water reminder and speech bubble tests. The Remote Desktop tests create and remove Windows credentials for fake `.invalid` servers.

## Notes and AI cleanup

Notes and the daily log live in `Documents\MochiVault\notes.md`. Never put passwords there. To tidy notes, ask Claude Code:

> reorganize my notes in ~/Documents/MochiVault/notes.md, keep the `# Notes` / `## title` and `# Daily` / `## YYYY-MM-DD` structure

The widget picks up the change automatically.
