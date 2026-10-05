---
title: Your data and privacy
nav_order: 6
permalink: /privacy/
description: Plain answers about what Canvas Pro-Tools stores, reads, and sends, with a link to the full privacy policy.
---

# Your data and privacy

Plain answers to the questions people ask before installing a Canvas extension. This page summarizes the [full privacy policy](https://github.com/Gustafsone/canvas-pro-tools/blob/main/canvas-pro-tools/PRIVACY.md), which is the authoritative text. This summary matches the policy dated 10/4/2026.

1. TOC
{:toc}

## In short

- The extension does not collect, send, sell, or share any data. There is no server, analytics, telemetry, or third party.
- Everything it saves stays in your browser's local extension storage on your own device. It is not part of Chrome Sync.
- It only talks to the Canvas site you are already on, using your existing Canvas login, and can only see what your Canvas account can already see.
- Student names, email addresses, grades, scores, submitted work, and comments are never written to storage.

## What the extension stores

Storage is kept separately for each Canvas site, so data from different institutions never mixes.

| Stored item | What it contains |
|---|---|
| Review markers | For each course you enable, entries in the form student ID and assignment ID with a review state. These are the numeric IDs Canvas already uses in its page addresses. |
| Course list | The course IDs you enabled for review tracking and each course's name, for labeling in the menu. |
| Custom review states | Labels, emoji, and colors you define. |
| Rubric checkpoint mappings | Which rubric criterion maps to which discussion checkpoint, plus rubric and course names for display. |
| Admin link settings | Which quick-access links show, their order, and any custom links you add. |
| Rubric association snapshots | From the Rubric Association Editor (Rubrics+): when you unlock a rubric for editing, the assignments it was attached to and their points are saved so they can be restored afterward, plus a short-lived note used to confirm the result after the page refreshes. Removed when you restore that rubric. Not included in exports or backups. Clear All removes any that remain. |
| Feature settings | Which features are on or off, and small interface preferences. |

## What it reads but does not store

To draw its on-page elements, the extension reads content from the Canvas pages you visit, such as rubric criteria, assignment settings, enrollment lists, and grading status. That is held in memory only while the page is open.

## Changes it can make in Canvas

Only when you click them, some features change data in Canvas: importing a rubric from a CSV, and unlocking and restoring a rubric's assignment associations. To do this the extension reads Canvas's own anti-forgery token from the page and sends it back to Canvas with the request, the same way Canvas's pages do. The token is held in memory only and is never stored or sent anywhere else.

## Permissions it asks for

| Permission | Why it is needed |
|---|---|
| `storage` | Saves your settings and review markers on your device. |
| `activeTab` | Reads the address of the tab you are viewing, so the popup knows which Canvas site and course you are in. |
| `https://*.instructure.com/*` | The features run on Canvas pages. The extension runs nowhere else. |

## Exporting and removing your data

You can export settings and review data to a JSON or CSV file from the popup. Exported files are ordinary files under your control, and rubric or assignment exports may contain course content, so handle them with care.

To remove stored data, open the popup, go to the **Data** tab, and use the Clear options. See [Settings and data]({{ '/settings/' | relative_url }}#data-tab). Uninstalling the extension also deletes its local storage.

## Questions

Questions about privacy can be sent to GustafsonES@gmail.com. You can also [open an issue on GitHub](https://github.com/Gustafsone/canvas-pro-tools/issues).

[Previous: Settings and data]({{ '/settings/' | relative_url }}){: .mr-4 }
[Next: Troubleshooting]({{ '/troubleshooting/' | relative_url }})
