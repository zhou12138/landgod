# 🖥️ LandGod Worker — Windows & macOS Quick Start

> Install LandGod Worker on your local machine to connect it to the LandGod remote management network.

---

## 📋 Prerequisites

| Dependency | Windows | macOS |
|------------|---------|-------|
| Node.js (v18+) | Download from [nodejs.org](https://nodejs.org/) | `brew install node` |
| npm | Included with Node.js | Included with Node.js |

---

## 🚀 Install LandGod Worker

Open a terminal (Windows: PowerShell, macOS: Terminal):

```bash
npm install -g https://raw.githubusercontent.com/zhou12138/cli-server/master/downloads/landgod-0.1.3.tgz
```

Verify the installation:

```bash
landgod --version
# Expected output: landgod 0.1.3
```

> 💡 If `landgod` is not recognized, close and reopen your terminal.

---

## 🐍 Install Python (Optional — required for screenshot/remote control)

LandGod includes built-in Computer Use capabilities (screenshot, click, type, scroll) that require Python. Skip this step if you don't need these features.

### Windows

```powershell
# Install Python
winget install Python.Python.3

# Close and reopen terminal, then install dependencies:
python -m pip install pyautogui
python -m pip install Pillow
```

### macOS

```bash
# macOS usually ships with python3. If not:
brew install python3

# Install dependencies
python3 -m pip install pyautogui
python3 -m pip install Pillow
```

> The Worker automatically detects Python at startup. If Python is not available, Computer Use is silently skipped — all other features work normally.

---

## ▶️ Start

```bash
landgod start --ui --demo
```

> ⚠️ `--demo` mode disables all security restrictions (command allowlist, content filtering, etc.). **Use only for demos and local testing.**

---

## ❓ Troubleshooting

| Problem | Solution |
|---------|----------|
| `landgod` command not found | Close and reopen terminal; or check that `npm prefix -g` is in your system PATH |
| Python features unavailable | Restart terminal after installing Python; verify with `python --version` (Windows) or `python3 --version` (macOS) |
| Electron errors | First run of `landgod start --ui` auto-installs Electron dependencies — requires internet |
| macOS permission prompt | Screenshot requires granting Screen Recording permission in System Settings → Privacy & Security |

---

## 🔗 Links

- [Gateway Setup Guide](./QUICKSTART-GATEWAY.md)
- [Full Documentation](../docs/)
