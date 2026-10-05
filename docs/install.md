---
title: Install
nav_order: 2
permalink: /install/
description: How to install Canvas Pro-Tools from the Chrome Web Store or load it unpacked.
---

# Install
{: .no_toc }

Canvas Pro-Tools installs as a Chrome extension. It needs desktop Chrome, or another Chromium browser that supports extensions.

## Install from the Chrome Web Store

1. Open the [Canvas Pro-Tools listing](https://chromewebstore.google.com/detail/canvas-pro-tools/kmknhmanmianmleefcabaocbekjjhplf) in Chrome.
2. Choose **Add to Chrome** and confirm.
3. Pin the Canvas Pro-Tools icon from the puzzle-piece menu so the popup is one click away.

## Advanced: load it unpacked

Most people should use the Chrome Web Store above. Load it unpacked only if you want to install straight from the repository, try a change before it reaches the store, or run it on a Canvas site that needs edited files.

1. On the [repository page](https://github.com/Gustafsone/canvas-pro-tools), choose **Code**, then **Download ZIP**. You can also clone the repository.
2. Unzip it somewhere permanent. Chrome reads the extension from that folder, so do not delete or move it afterward.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Choose **Load unpacked** and select the `canvas-pro-tools` folder inside the download. This is the folder that contains `manifest.json`, not the top-level repository folder.
6. Pin the Canvas Pro-Tools icon from the puzzle-piece menu.

{: .screenshot }
> [SCREENSHOT: chrome://extensions with Developer mode and Load unpacked highlighted]

## Check that it worked

Open your Canvas site and click the toolbar icon. The popup should list the available features. If it does not, see [Troubleshooting]({{ '/troubleshooting/' | relative_url }}).

The extension runs only on Canvas sites at an `instructure.com` address. See [Compatibility]({{ '/' | relative_url }}#before-you-install).

## Updating

- **Chrome Web Store installs:** Chrome normally updates store extensions on its own. You can also open `chrome://extensions`, turn on **Developer mode**, and choose **Update**.
- **Unpacked installs:** replace the contents of your extension folder with the new version, then open `chrome://extensions` and press the reload icon on the Canvas Pro-Tools card.

[Next: Quick start]({{ '/quick-start/' | relative_url }})
