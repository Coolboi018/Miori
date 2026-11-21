# Miori

**Anime streaming mobile app** built with **Expo**, **React Native**, and **TypeScript**.

[![GitHub Stars](https://img.shields.io/github/stars/Coolboi018/Miori?style=for-the-badge)](https://github.com/Coolboi018/Miori)
[![GitHub Forks](https://img.shields.io/github/forks/Coolboi018/Miori?style=for-the-badge)](https://github.com/Coolboi018/Miori)

---

## 📖 What is Miori?

Miori is a mobile anime streaming application with a **modular extension system**. Browse episodes, stream videos, and manage your watch history — all with a clean, lightweight UI that runs smoothly even on low-end devices.

> **Developer:** Ishu (CoolBoi018)  
> **GitHub:** [Coolboi018](https://github.com/Coolboi018)  
> **Miori Repo:** [https://github.com/Coolboi018/Miori](https://github.com/Coolboi018/Miori)  
> **Miori-Extensions Repo:** [https://github.com/Coolboi018/Miori-Extensions](https://github.com/Coolboi018/Miori-Extensions)  
> **License:** MIT  
> **Platform:** Android (APK), Web (Expo)

---

## ✨ Features

- 🎬 **Modular extension system** — add new streaming sources by linking external repos directly
- 📡 **Built-in Anilist support** — catalog, login, episode data all from Anilist
- 💬 **Discord Rich Presence** — show what you're watching on Discord
- 🎧 **Lightweight player** — optimized for low-end devices, smooth playback
- ⚡ **Expo Router navigation** — deep linking, universal links, seamless screens
- 🌐 **Cross-platform** — Android and Web from a single codebase

---

## 🧩 Extensions

Miori supports pluggable extensions. To add an extension, just provide the **Git repo URL** in the app's extension manager.

- **Official extensions repo:** <https://github.com/Coolboi018/Miori-Extensions>
- Extensions are loaded dynamically — no app update needed to add new sources

> _Extensions add extra streaming sources (e.g., direct links, other anime APIs). The core Anilist catalog and login are built into the app and updated via app updates, not extensions._

---

## 🛠️ Tech Stack

| Layer                | Technology                                     |
| -------------------- | ---------------------------------------------- |
| **Framework**        | Expo (React Native)                            |
| **Language**         | TypeScript                                     |
| **Navigation**       | Expo Router                                    |
| **State Management** | React Query                                    |
| **Styling**          | React Native Components + Custom CSS           |
| **Extensions**       | Custom module system (loadable from Git repos) |
| **Build/Release**    | EAS (Expo Application Services)                |

---

## 📦 Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Coolboi018/Miori.git

# 2. Install dependencies
cd Miori
npm install   # or: bun install / yarn

# 3. Run the app
npx expo start

# 3. Open Android / Web
#   - Android: npx expo run:android
#   - Web:   npx expo start --web
#   - 📝 iOS builds require a macOS development environment — not currently supported
```

---

## 🔧 Adding Your Own Extension

If you want to add a custom extension to Miori:

1. Create a repo following the extension format
2. Go to **Extensions** in the app settings
3. **Paste the Git repo URL** (e.g., `https://github.com/Coolboi018/some-extension`)
4. The extension will be fetched and loaded automatically

---

## 📸 Screenshots

| Light Mode                                                                  | Dark Mode                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| <img src="https://github.com/user-attachments/assets/example1" width="300"> | <img src="https://github.com/user-attachments/assets/example2" width="300"> |

_(Add your own screenshots by replacing the URLs with actual image paths in your repo.)_

---

## 🤝 Contributing

1. Fork the repo
2. Create a branch (`git checkout -b feature/xyz`)
3. Commit your changes (`git commit -m "Add feature xyz"`)
4. Push (`git push origin feature/xyz`)
5. Open a Pull Request

> _Please keep the extension system modular and avoid committing sensitive keys/secrets._

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

Copyright (c) 2026 CoolBoi018

---

## 📞 Contact

- **GitHub:** [@Coolboi018](https://github.com/Coolboi018)
- **Discord:** ishuxo018
- **Discord Server:** [Join Community](https://discord.gg/RycG5KdNXF)

---

_Built with ❤️ using Expo and React Native._
