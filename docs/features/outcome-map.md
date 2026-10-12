---
title: Outcome Map
parent: Features
nav_order: 4
permalink: /features/outcome-map/
description: See every course outcome and the assignments, quizzes, and question banks aligned to it in one view, check every assignment's rubric, then clean up duplicates and leftovers.
---

# Outcome Map
{: .d-inline-block }

New in 4.2.0
{: .label .label-green }

On by default. **Where:** the course Outcomes page (the classic Outcomes page). **For:** instructors, instructional designers, deans, and admins.

Canvas shows outcome alignments one outcome at a time, and lists every assignment a rubric is attached to, which makes the big picture hard to see. The Outcome Map puts every outcome and everything aligned to it on one page, checks every assignment's rubric, and lists what looks worth cleaning up.

The map has three tabs: **Map**, **Outcome Cleanup**, and **Rubrics**.

The map only reads from Canvas. It never changes anything and saves nothing.

1. TOC
{:toc}

## Open the map

1. Open a course's **Outcomes** page.
2. Click **Outcome Map**, next to **Find**. The map opens in a new tab, so the Outcomes page stays open in the first one.

The map appears in a few seconds. It then reads the course's Classic Quiz question banks. If any bank is aligned to an outcome, it also checks the course's Classic Quizzes to see which banks each quiz draws questions from. A progress bar under the status line shows each step, such as "Reading question banks: 6 of 19" or "Checking quizzes: 30 of 44". A course with many banks and quizzes can take a little longer, because each one is read separately.

{: .screenshot }
> [SCREENSHOT: the Outcome Map button next to Find on the Outcomes page]

## Read the map

Assignments run down the side, grouped by assignment group. Outcomes run across the top, grouped by outcome group. Question banks aligned to an outcome get their own rows at the bottom, each showing which quizzes use it, or **Not used by any quiz**.

A Classic Quiz that draws questions from an aligned bank gets marks for that bank's outcomes on its own row, with a **Quiz** badge, so you can see which quizzes assess which outcomes.

| Mark | Meaning |
|---|---|
| ● | A rubric criterion on the assignment, a question bank the quiz draws from, or the question bank itself is aligned to that outcome |
| ○ | Only in courses that mix both kinds: a tracked-only criterion (see Grading below) |
| **Inst.** | An Institution outcome, created at the account level |
| **Course** | An outcome created in this course |
| **Other** | An outcome created in a different course and copied in |
| ⚑ | An outcome the map suggests you likely remove (see the Outcome Cleanup tab) |

A key above the map shows the marks that appear in your course. Hover a column header for the full outcome title, description, and ID. Hover a mark for the rubric and criterion, or the question bank and its mastery percentage. On a quiz row, the hover text says how many questions the quiz draws from which bank, for example "Draws 4 questions (3 pts each) from bank Course Objective 1".

Totals show how many outcomes each assignment covers and how many assignments and question banks assess each outcome. When two outcomes in the same group share a number, they are labeled 1a, 1b, and so on.

The **legend** under the map lists every outcome with its source, description, outcome group, ID, how many assignments and banks use it, and whether Canvas will let you remove it now.

{: .screenshot }
> [SCREENSHOT: the map with outcome columns, assignment rows, and the key]

### Notes above the map

- **What this map includes:** rubrics on assignments, and Classic Quiz question banks that belong to the course. It does not include New Quizzes item banks, or question banks stored in other courses or accounts.
- **Grading:** whether the outcome criteria count toward the grade. A tracked-only criterion records an outcome result when the instructor selects a rating, but its points are left out of the grade. A scored one adds its points into the grade.
- **Blueprint:** in a Blueprint course, a reminder that changes sync to associated courses. In a course that receives Blueprint content, a link to the Blueprint, because shared rubrics and outcomes should be fixed there.

Assignment rows can carry small badges: **Unpublished**, **No rubric**, **Rubric not used for grading**, and **Locked by Blueprint** (or **Locked in associated courses** in the Blueprint itself).

## Clean up outcomes

The **Outcome Cleanup** tab waits until the question banks and quizzes have been read, so an outcome assessed only through a quiz bank is never reported as unused.

### What the tab numbers mean

The number on a tab, such as **Outcome Cleanup (3)**, is how many of that tab's checks found something. It is not the number of items to fix. Hover the tab to see, for example, "3 of 9 checks found something."

Each tab opens with a **Checks** list that names every check and its result, either **None found** or a count. Click a check to jump to it. The number of checks can change from course to course: **Aligned question banks no quiz uses** only appears when the course has a question bank aligned to an outcome.

After the Checks list comes a **suggested fix order**:

1. Point rubric criteria at the outcome you are keeping, and on question bank pages align the kept outcome and remove the old one.
2. Remove the outcomes you no longer need from the course Outcomes page.
3. Delete rubrics that are not attached to any assignment, if no one needs them. The **Unattached rubrics** list on the Rubrics tab marks the likely ones.
4. Click **Refresh** in the map to check the result.
5. In a Blueprint course, sync so associated courses receive the fixes.

Then it lists:

- **Likely remove:** suggestions, each with its reason and whether Canvas will let you remove it yet.
- **Possible duplicate outcomes:** outcomes with very similar wording but different IDs, often an old and a revised version. This is a wording match, so review before acting.
- **Outcomes not used by any assignment or question bank.**
- **Outcomes that may belong to another course:** course-level outcomes created in a different course, and outcomes whose description names a different course code.
- **Rubrics not attached to any assignment that carry outcomes.** Canvas still lists these as alignments, which is why its own Outcomes page looks cluttered.
- **Assignments with no outcome.** A Classic Quiz that draws from an aligned bank is not listed here.
- **Aligned question banks no quiz uses:** these never record outcome results.
- **Outcomes on rubrics or question banks but not in this course.**
- **More than one outcome group in use.**

Each item links to its Canvas page, which opens in a new tab. Make any change there, then click **Refresh**.

{: .screenshot }
> [SCREENSHOT: the Outcome Cleanup tab with the Checks list, the fix order, and the Likely remove list]

### How "Likely remove" is decided

An outcome is marked ⚑ when either is true:

- It is a course-level duplicate that nothing uses, and its duplicate set has an Institution outcome or an in-use outcome to keep.
- Its description names a different course code than the course, such as NRSG 403 in an NRSG 412 course.

These are suggestions, not decisions. If the outcome is still used, move those alignments first. Canvas will not remove an outcome from a course while a rubric or question bank still uses it, and the **Can remove now** column shows which ones it will allow.

## Check rubrics

The **Rubrics** tab checks every assignment and every rubric in the course, whether or not they use outcomes. It is ready as soon as the map loads, because it uses the assignments and rubrics the map has already read.

Its **Checks** list has five checks. These are the ones counted in the tab number:

- **Graded assignments with no rubric.** Quizzes and ungraded assignments are skipped.
- **Points mismatches:** the assignment's points differ from its rubric's total. When the rubric is used for grading, the rubric total sets the score, so a mismatch changes what students can earn. When the rubric is not used for grading, the difference is shown as a softer note.
- **Rubrics shared by more than one assignment.** Canvas will not let you edit these. With **Rubrics+** on, the **Unlock rubric for editing** button on the rubric page detaches the extra assignments so you can edit, and **Restore associations** reattaches them. See [Features for everyone]({{ '/features/everyone/' | relative_url }}#rubric-association-editor).
- **Duplicate rubric copies:** rubrics with the same title (or the same title plus a "(1)" style suffix), or with identical criteria, which catches copies renamed by hand. Copies are grouped into numbered copy sets.
- **Unattached rubrics marked likely remove** (see below).

The tab also notes, without counting them, how many rubrics are not attached to any assignment and how many have no outcome criteria.

Below the Checks list are three tables:

- **Assignments**, grouped by assignment group: points, rubric (linked), rubric total, whether the rubric is used for grading, how many of its criteria are linked to outcomes, and any flags.
- **All rubrics in this course:** each rubric's total, criteria, outcome criteria, the assignments that use it, and any flags. Copy sets are listed together.
- **Unattached rubrics:** every course rubric that no assignment uses, with a hint.

{: .screenshot }
> [SCREENSHOT: the Rubrics tab with the Checks list and the Assignments table]

### Unattached rubrics: Likely remove or Review

In the **Unattached rubrics** table, a rubric is marked **Likely remove** when either is true:

- It has no criteria at all.
- It is a copy of a rubric that is attached to an assignment, usually a leftover from a course copy. The reason column names the attached rubric.

Anything else is marked **Review**, for example a rubric someone saved for later.

{: .important }
> Check the rubric page before deleting. A rubric used only on an ungraded discussion also shows as unattached, because ungraded discussions are not in the assignment list. Deleting a rubric in Canvas removes its past assessments.

Account rubrics are left out of this table, because they are managed at the account level. A note gives their count.

## Export and print

- **Export Map CSV:** the map as a spreadsheet, with each outcome's source, description, and whether it can be removed now.
- **Export Outcome Cleanup CSV:** every Outcome Cleanup item with its source, details, hint, and link.
- **Export Rubrics CSV:** three blocks: assignments, all rubrics, and unattached rubrics, with flags and links.
- **Print:** a landscape copy of the **Map** and **Outcome Cleanup** tabs. With the **Rubrics** tab selected, Print gives a copy of the Rubrics tab on its own.

## Limits

- Works on the classic Outcomes page.
- Reads only question banks that belong to the course. New Quizzes item banks are not included.
- Quiz links come from each quiz's question groups. A group of hand-picked questions is not linked, and a group that draws from a bank stored outside the course is counted in the notes but not mapped.
- Possible duplicates and course-code mismatches are found by matching text, so review them before removing anything.
- The Rubrics tab reads rubrics through assignments. Rubrics used only on ungraded discussions show as unattached.

[Previous: Admin and dean tools]({{ '/features/admin/' | relative_url }}){: .mr-4 }
[Next: Settings and data]({{ '/settings/' | relative_url }})
