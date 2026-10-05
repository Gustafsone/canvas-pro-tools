---
title: Settings and data
nav_order: 5
description: What each tab of the Canvas Pro-Tools popup does, and how to back up, move, or clear your data.
---

# Settings and data

Everything is controlled from the popup that opens when you click the Canvas Pro-Tools icon in the toolbar. This page walks through each tab.

1. TOC
{:toc}

{: .screenshot }
> [SCREENSHOT: the popup with its tab row]

## Settings belong to one Canvas site

The popup shows which Canvas site it is working with. Your feature toggles, review markers, links, and mappings are saved separately for each site, so using the extension at two institutions never mixes their data.

## Tools tab

One toggle for each feature, grouped as Everyone, SpeedGrader tweaks, and Dean / Admin. Use the description control next to a feature to read what it does. Most changes take effect the next time a Canvas page loads. See [Quick start]({{ '/quick-start/' | relative_url }}) for the defaults.

## Tracker tab

- **Courses:** lists the courses where you enabled review tracking. The **Global** toggle pauses tracking on all of them at once without losing any data.
- **States:** shows the default states (Needs Review, Needs Action, Reviewed) and lets you add up to four custom ones, each with an emoji, a label, and an indicator color. Changes apply right away to every open gradebook tab.

## Mappings tab

Lists the rubric-to-checkpoint mappings saved by the [Checkpoint Rubric Mapper]({{ '/features/everyone/' | relative_url }}#checkpoint-rubric-mapper). Each mapping belongs to a rubric and is reused for any assignment that uses that rubric. You can clear all mappings here.

This tab, and the Mappings section of the Data tab, appear only while the Checkpoint Rubric Mapper is switched on.

## Links tab

Controls the quick-access links that Admin Course Links adds under each course. Turn links on or off, reorder them, and add your own. See [Admin Course Links]({{ '/features/admin/' | relative_url }}#admin-course-links).

## Data tab

Back up, move, or remove what the extension has saved for this Canvas site. Exports are downloaded as JSON files.

| Category | Export | Clear |
|---|---|---|
| Tracker (markers, course settings, custom states) | Yes | Yes |
| Links (order, toggles, custom links) | Yes | Resets to defaults |
| Mappings (checkpoint rubric mappings) | Yes | Yes |
| Settings (which tools are on or off) | Yes | Not included in Clear All |

### Full backup

- **Export All** downloads everything in a single file.
- **Import** restores from a backup. The file is inspected first, and you choose which categories to restore before anything is overwritten.
- **Clear All Data** removes tracker data, link configuration, checkpoint mappings, and any saved rubric association snapshots. It never removes your feature settings.

Rubric association snapshots, saved by the [Rubric Association Editor]({{ '/features/everyone/' | relative_url }}#rubric-association-editor), are not included in exports or backups. They are kept until you restore that rubric, and Clear All removes any that remain.

{: .important }
> Clearing cannot be undone. Export a backup first if you might want the data later.

## Per-course export in the gradebook

The Review Tracker control in the gradebook has its own menu with **Tips & Help**, **Export course data**, **Import course data**, and **Clear course data**. Clearing removes all markers for that course and turns the tracker off for it. Importing asks you to confirm before it overwrites anything.

## About tab

Shows the installed version and credits the authors whose work some features are adapted from. See [Credits]({{ '/credits/' | relative_url }}).

[Previous: Admin and dean tools]({{ '/features/admin/' | relative_url }}){: .mr-4 }
[Next: Your data and privacy]({{ '/privacy/' | relative_url }})
