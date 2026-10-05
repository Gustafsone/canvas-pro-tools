---
title: Changelog
nav_order: 8
description: What changed in each Canvas Pro-Tools release.
---

# Changelog

{: .confirm }
> This draft is built from the version number in the manifest and from comments in the source code, not from real release notes. Add release dates and replace or extend the entries with your own notes.

## 4.1.0
{: .d-inline-block }

Current version
{: .label .label-green }

{: .confirm }
> Release date.

- **New:** Rubric Association Editor, under the Rubrics+ switch. Lets you edit a rubric that Canvas has locked because it is attached to several assignments, then restore the associations. See [Features for everyone]({{ '/features/everyone/' | relative_url }}#rubric-association-editor).
- **Changed:** Clear All Data in the popup now also removes any saved rubric association snapshots. Snapshots are not part of exports or backups.
- **Changed:** the Gradebook Review Tracker is now set from an indicator button on the left side of a grade cell and a button in each column header, instead of by right-clicking.

{: .confirm }
> The version in which the Review Tracker changed from right-click to buttons. Move that item to the right release if it was not 4.1.0.

## 4.0.0

{: .confirm }
> Release date, and the user-visible changes. The privacy policy states that it applies to version 4.0.0 and later, and the store disclosures were first written against 4.0.0. List what else changed.

## 3.7.0

- Checkpoint Rubric Mapper mappings are now saved per rubric. This was a deliberate clean break: mappings saved before 3.7.0 were not migrated, so a rubric mapped in an earlier version needs to be mapped again.

## 3.6.4

- Saved data is now kept separately for each Canvas site, so two institutions never share markers or settings. Older data is migrated when you open the popup.

[Previous: Troubleshooting]({{ '/troubleshooting/' | relative_url }}){: .mr-4 }
[Next: Credits]({{ '/credits/' | relative_url }})
