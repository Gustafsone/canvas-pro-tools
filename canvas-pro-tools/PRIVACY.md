# Canvas Pro-Tools - Privacy Policy

**Last updated:** 10/4/2026
**Applies to:** Canvas Pro-Tools browser extension, version 4.0.0 and later

## Summary

Canvas Pro-Tools does not collect, transmit, sell, or share any data. There is
no server, no analytics, no telemetry, and no third party of any kind. Every
piece of information the extension creates stays in your own browser on your
own device.

## What the extension stores on your device

Canvas Pro-Tools uses your browser's local extension storage
(`chrome.storage.local`). This storage lives only on the computer where you
installed the extension. It is not part of Chrome Sync, so it is not copied to
your Google account or to any other machine you sign in to.

The following is stored, separated by Canvas site so that data from different
institutions never mixes:

| Stored item | What it contains |
|---|---|
| Review markers | For each course you enable, a list of entries in the form `studentID_assignmentID` paired with a review state such as "Reviewed" or "Needs attention". These are the numeric IDs Canvas already uses in its own page addresses. |
| Course list | The Canvas course IDs you have enabled for review tracking, and each course's name, so the extension can label them in its menu. |
| Custom review states | Any labels, emoji, and colors you define for your own review workflow. |
| Rubric checkpoint mappings | For each rubric you map, which rubric criterion corresponds to which discussion checkpoint, plus the rubric and course names for display. |
| Admin link settings | Which quick-access links you want shown, their order, and any custom link labels and paths you add. |
| Rubric association snapshots | From the Rubric Association Editor (Rubrics+): when you unlock a rubric for editing, the assignments it was attached to and their points are saved so they can be restored afterward, along with a short-lived note used to confirm the result after the page refreshes. A snapshot is removed when you restore that rubric. It is not included in exports or backups, and the popup's Clear All removes any that remain. |
| Feature settings | Which features you have turned on or off, and small interface preferences such as which panels are expanded. |

**Student names, email addresses, grades, scores, submitted work, and comments
are never written to this storage.** Review markers reference students only by
the numeric ID that already appears in the Canvas URL you are looking at.

## What the extension reads but does not store

To display information on the page, the extension reads content from the Canvas
pages you visit, such as rubric criteria, assignment settings, enrollment lists,
and grading status. This is processed in your browser to draw the extension's
own on-page elements. It is held in memory only for as long as the page is open
and is discarded when you navigate away or close the tab.

## Network activity

The extension makes requests only to the Canvas site you are currently using,
through Canvas's own public API on the same domain. Examples include reading a
rubric's criteria, listing a course's assignments, or fetching a submission's
grading timestamp.

These requests are made with your existing Canvas login session, exactly as if
the Canvas page itself had made them, and they return only information your
Canvas account is already permitted to see. The extension cannot access anything
your Canvas permissions do not already allow.

Some features change data in Canvas, but only when you click them: importing a
rubric from a CSV, and unlocking and restoring a rubric's assignment
associations. To make those requests, the extension reads Canvas's own
anti-forgery token (the `_csrf_token` cookie on the Canvas page) and sends it
back to Canvas with the request, the same way Canvas's own pages do. The token
is held in memory only and is never stored or sent anywhere else.

**The extension never sends data to any server operated by the developer or by
anyone else.** There are no requests to any domain other than the Canvas site
you are on.

## Permissions and why they are needed

| Permission | Why it is required |
|---|---|
| `storage` | To save your settings and review markers on your device. |
| `activeTab` | To read the address of the tab you are currently viewing, so the extension popup knows which Canvas site and course you are working in. |
| `https://*.instructure.com/*` | The extension's features run on Canvas pages, so it needs permission to operate on Canvas-hosted sites. It runs nowhere else. |

## Data you export yourself

The extension can export your settings and review data to a JSON or CSV file
when you choose to do so. Those files are written to your computer's normal
downloads location. Once exported, they are ordinary files under your control,
and this policy no longer governs what happens to them. Exported rubric and
assignment files may contain course content, so handle and share them with the
same care you would apply to any other document from your Canvas courses.

## Removing your data

Removing everything the extension has stored can be done in either of two ways:

- Open the extension popup, go to the **Data** tab, and use the Clear options.
- Uninstall the extension. Chrome deletes an extension's local storage when the
  extension is removed.

## Children's privacy

Canvas Pro-Tools is a tool for instructors and administrators managing courses
in Canvas LMS. It is not directed at children and is not intended for use by
students.

## Changes to this policy

If this policy changes, the updated version will be posted at this address and
the "Last updated" date above will be revised. Material changes will also be
noted in the extension's release notes.

## Contact

Questions about this policy can be directed to:

GustafsonES@gmail.com