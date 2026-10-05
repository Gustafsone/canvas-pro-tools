---
title: For everyone
parent: Features
nav_order: 1
permalink: /features/everyone/
description: Gradebook Review Tracker, What-If Grades, Rubrics+, Assignment Details, and Checkpoint Rubric Mapper.
---

# Features for everyone

These tools are meant for any instructor. Turn each one on or off in the popup's **Tools** tab. Most changes take effect the next time the Canvas page loads.

1. TOC
{:toc}

## Gradebook Review Tracker

Off by default. **Where:** the gradebook, the submission tray, and SpeedGrader.

Mark which student submissions you have reviewed and which still need attention.

1. Turn the feature on in the popup, then open a course's gradebook and enable the tracker from the menu arrow.
2. Click the indicator button on the left side of a grade cell and choose a review status. Choose **Not tracked** to clear it.
3. To mark every visible student in a column at once, click the button in the column header, next to Canvas's own icons.
4. In the submission tray, a Review Status badge appears below the Status section. In SpeedGrader, the Review Status badge in the grade area marks the current student. Marks sync back to the gradebook.

In the popup's **Tracker** tab you can add up to four custom states with your own emoji, label, and color, and use the **Global** toggle to pause tracking without losing data.

{: .screenshot }
> [SCREENSHOT: gradebook with review markers]

## What-If Grades

On by default. **Where:** a student's grades page, in the instructor view.

Adds a What-If Score column so you can type hypothetical scores and see the effect on current and final grades as you type.

- It works for 0-point extra credit assignments too.
- Type `EX` to model an assignment being excused and dropped.
- Group subtotals update live.
- **Reset** clears every hypothetical score.

## Rubrics+

On by default. **Where:** rubric pages, the course Rubrics list, assignments, discussions, and quizzes.

One switch that turns on a group of rubric tools.

- **Find a Rubric dialog:** the current course moves to the top and term information is added to each entry.
- **Export CSV:** a button on rubric pages, assignments, discussions, and quizzes. On quiz pages the CSV opens in a new tab, so allow pop-ups for your Canvas site.
- **Rubrics list page:** a download icon on each rubric, plus sidebar buttons for Import Rubric, Download Template, Export All Rubrics, and Load Rubric Details.
- **Used-for-grading badge:** on an assignment, flags whether the attached rubric is actually used for grading.
- **Associations report:** on a rubric page, lists everything the rubric is attached to.

When you import a CSV that holds several rubrics, Canvas creates each one separately and uses the Rubric Name column to tell them apart.

### Rubric Association Editor
{: .d-inline-block }

New in 4.1.0
{: .label .label-blue }

**Where:** an individual rubric page. It runs under the Rubrics+ switch.

Canvas hides the Edit button on a rubric that is attached to more than one assignment. This tool works around that in two steps.

1. Choose **Unlock rubric for editing** and confirm in the dialog. The extension saves a snapshot of every assignment association except the first, then removes those associations. The rubric stays attached to one assignment, and the page refreshes so Canvas shows Edit again.
2. Edit the rubric in Canvas as usual and save it.
3. Choose **Restore associations**. The extension re-creates the saved associations, then refreshes and checks the result against the live data.

What to know:

- Only assignment associations are touched. Course and account associations are never removed.
- The snapshot is saved to your browser's local storage before anything is removed, so it survives the page refresh and a browser restart.
- Restore can be repeated. It skips associations that are already back, so a partial failure can be retried.
- The page does not refresh itself while the rubric edit form is open, so unsaved edits are not lost.
- If the rubric is attached to fewer than two assignments, the tool tells you there is nothing to detach.

{: .important }
> **Check assignment points after restoring.** Restoring can change an assignment's points. After a restore, the extension compares each assignment's points with what they were before and shows the result, so review that table. The extension also reminds you to check that rubric scores still appear on the affected assignments.

{: .confirm }
> What other assignments show while the rubric is detached from them. This is not stated in the code comments, so describe it only after testing in Canvas.

{: .screenshot }
> [SCREENSHOT: rubric page with the Unlock rubric for editing button]

## Assignment Details

On by default. **Where:** the course Assignments page.

Open the options menu at the top of the page and choose **Load assignment details**. Each assignment is then annotated with:

- its submission type, including the tool's name for external tool assignments, with Classic Quizzes and New Quizzes labeled;
- whether it counts toward the final grade;
- its attached rubric, linked, with whether the rubric is used for grading and any outcome criteria.

Nothing on the page changes until you run it.

## Checkpoint Rubric Mapper

Off by default. **Where:** checkpoint-enabled discussions, rubric pages, the Rubrics list, and SpeedGrader.

For checkpoint discussions with a rubric, assign each criterion to **Reply to Topic**, **Required Replies**, or **Ignore** by clicking the small pill on its row.

- The same pills appear on an individual rubric's page, so you can map a rubric before it is attached.
- The Rubrics list marks mapped rubrics.
- Mappings are saved per rubric and reused wherever that rubric appears.
- In SpeedGrader, saving the rubric assessment adds up the mapped scores and writes them to the checkpoint grade boxes.

[Previous: Features]({{ '/features/' | relative_url }}){: .mr-4 }
[Next: In SpeedGrader]({{ '/features/speedgrader/' | relative_url }})
