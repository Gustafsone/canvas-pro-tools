---
title: Troubleshooting
nav_order: 7
description: Common problems with Canvas Pro-Tools and what to try, plus how to report a problem.
---

# Troubleshooting

Common problems and what to try. If none of these help, see [How do I report a problem?](#how-do-i-report-a-problem).

1. TOC
{:toc}

## A feature does not appear

1. Open the toolbar popup and confirm the feature is switched on in the **Tools** tab. Some features start off. See [Quick start]({{ '/quick-start/' | relative_url }}#what-is-on-by-default).
2. Reload the Canvas page.
3. Open `chrome://extensions` and press the reload icon on the Canvas Pro-Tools card.
4. Confirm you are on a Canvas page the feature supports. See the table below.
5. Confirm your Canvas site address ends in `instructure.com`. The extension does not run on custom domains.

### Where each feature runs

Each feature only acts on the Canvas pages listed here. These come from the extension's manifest for version 4.1.0.

| Feature | Canvas pages |
|---|---|
| Gradebook Review Tracker | The course gradebook (`/courses/…/gradebook`), and SpeedGrader for the Review Status badge |
| What-If Grades | A student's grades page (`/courses/…/grades/…`) |
| Rubrics+ | Rubric pages and the Rubrics list, plus assignments, quizzes, and discussions. The Rubric Association Editor runs on an individual rubric page only |
| Assignment Details | The course Assignments list only (`/courses/…/assignments`) |
| Checkpoint Rubric Mapper | Discussions, rubric pages, the Rubrics list, and SpeedGrader |
| Quiz Nav and Highlighting | A quiz's submission history page, including inside SpeedGrader |
| Graded At Timestamp | SpeedGrader |
| Avatar Zoom | SpeedGrader |
| Admin Course Links | Account admin pages (`/accounts/…`) |
| User Enrollments | A user's page (`/users/…` and `/accounts/…/users/…`) |

## It stopped working after a Canvas update

Canvas can change its page layout, which can break an extension that reads the page. Check the [changelog]({{ '/changelog/' | relative_url }}) for a newer version, and if the problem remains, report it with the steps below.

## My settings or review marks did not save

If you keep Canvas open in several tabs at once, changes made in one tab can overwrite changes made in another. Work in one tab at a time for now.

{: .confirm }
> This is a suspected known issue with a fix planned. Confirm it before publishing, and update this item when the fix ships.

## How do I report a problem?

[Open an issue on GitHub](https://github.com/Gustafsone/canvas-pro-tools/issues) and include:

- The extension version, shown in the popup's **About** tab.
- The kind of Canvas page you were on.
- What you expected and what happened instead.
- Any error text from the page. Do not include student names or grades.

[Previous: Your data and privacy]({{ '/privacy/' | relative_url }}){: .mr-4 }
[Next: Changelog]({{ '/changelog/' | relative_url }})
