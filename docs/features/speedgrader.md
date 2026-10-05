---
title: In SpeedGrader
parent: Features
nav_order: 2
description: Review Status badge, Quiz Nav and Highlighting, Graded At Timestamp, Avatar Zoom, and checkpoint scores in SpeedGrader.
---

# SpeedGrader and quiz tools

Small additions that show up while you grade. Turn each one on or off in the popup's **Tools** tab.

1. TOC
{:toc}

## Review Status badge

Off by default, because it is part of the [Gradebook Review Tracker]({{ '/features/everyone/' | relative_url }}#gradebook-review-tracker). **Where:** the grading panel in SpeedGrader, between the grade inputs and Assignment Comments.

When the Review Tracker is on, SpeedGrader shows a Review Status badge. Click it to open a short menu and mark the current student's submission as **Needs Review**, **Needs Action**, **Reviewed**, or **Not tracked**. The badge updates as you move between students, and your marks sync with the gradebook. If you added custom states in the popup, they appear in the menu too.

See [Gradebook Review Tracker]({{ '/features/everyone/' | relative_url }}#gradebook-review-tracker) for turning tracking on for a course.

{: .screenshot }
> [SCREENSHOT: SpeedGrader grade panel with the Review Status badge]

## Quiz Nav and Highlighting

On by default. **Where:** a quiz's submission history page, including when it appears inside SpeedGrader.

Color-codes the question links in the quiz navigation so you can see at a glance which questions need your attention. A legend is added to the quiz header.

| Color | Meaning |
|---|---|
| Pale yellow | Unanswered |
| Light pink | Incorrect |
| Light purple | Needs manual review: essay, short answer, and fill-in-multiple-blanks questions |

Adapted from Canvancement's grade-by-question work. See [Credits]({{ '/credits/' | relative_url }}).

## Graded At Timestamp

On by default. **Where:** the submission info area in SpeedGrader.

Shows when a submission was graded and whether that was done by hand or automatically. The line reads **Manually graded:** or **Auto-graded:** followed by the date and time, for example "Oct 4 at 3:45pm". If Canvas has no graded time for the submission, it shows **Not graded**.

## Avatar Zoom

Off by default. **Where:** SpeedGrader.

Hover over a student's avatar to enlarge it to twice its size, which helps when you identify students by photo. It starts off because it changes how photos behave while grading, which is a choice each grader should make. Adapted from Canvancement.

## Checkpoint scores from a rubric

With the [Checkpoint Rubric Mapper]({{ '/features/everyone/' | relative_url }}#checkpoint-rubric-mapper) on, SpeedGrader shows a mapping pill on each rubric criterion while the rubric is open. When you save the rubric assessment, the extension adds up the scores for each checkpoint and fills in the checkpoint grade boxes. The pills are only visible while the rubric is open.

[Previous: Features for everyone]({{ '/features/everyone/' | relative_url }}){: .mr-4 }
[Next: Admin and dean tools]({{ '/features/admin/' | relative_url }})
