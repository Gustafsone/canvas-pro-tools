---
title: Credits
nav_order: 9
description: Attribution and licenses for the open-source work that some Canvas Pro-Tools features are adapted from.
---

# Credits

Canvas Pro-Tools includes features adapted from original work by other authors, with thanks. The full license texts are in [CREDITS.md](https://github.com/Gustafsone/canvas-pro-tools/blob/main/canvas-pro-tools/CREDITS.md) in the repository.

1. TOC
{:toc}

## Canvancement, by James Jones

Original work by James Jones ([@jamesjonesmath](https://github.com/jamesjonesmath)), published in the [Canvancement](https://github.com/jamesjonesmath/canvancement) project and used under the ISC License.

| Canvas Pro-Tools feature | Adapted from |
|---|---|
| Avatar Zoom | [canvas-css-tweaks.user.js](https://github.com/jamesjonesmath/canvancement/blob/master/miscellaneous/canvas-css-tweaks.user.js) |
| Find Rubric Sorter (Rubrics+) | [find-rubric-sorter.user.js](https://github.com/jamesjonesmath/canvancement/blob/master/rubrics/find-rubric-sorter/find-rubric-sorter.user.js) |
| Admin Course Links | [admin-course-links](https://github.com/jamesjonesmath/canvancement/tree/master/courses/admin-course-links) |
| Quiz Navigation and Highlighting | [grade_by_question](https://github.com/jamesjonesmath/canvancement/tree/master/quizzes/grade_by_question) |

## Canvas LMS Mods, by Code with Ski

Original work by James Sekcienski ([@Code-with-Ski](https://github.com/Code-with-Ski)), published in the [Canvas-LMS-Mods](https://github.com/Code-with-Ski/Canvas-LMS-Mods) project and used under the MIT License.

These features were reimplemented against Canvas Pro-Tools' own conventions rather than copied. The behavior, the Canvas endpoints, and the presentation approach are adapted from the original. The code is not.

| Canvas Pro-Tools feature | Adapted from |
|---|---|
| Rubric used-for-grading badge (Rubrics+) | [feature-rubric-use-for-grading-notification](https://github.com/Code-with-Ski/Canvas-LMS-Mods/tree/main/canvas-mods/courses/assignments/feature-rubric-use-for-grading-notification) |
| Load Rubric Details (Rubrics+) | [feature-load-rubric-details](https://github.com/Code-with-Ski/Canvas-LMS-Mods/tree/main/canvas-mods/shared-locations/rubrics/feature-load-rubric-details) |
| Rubric associations report (Rubrics+) | [feature-load-rubric-associations](https://github.com/Code-with-Ski/Canvas-LMS-Mods/tree/main/canvas-mods/shared-locations/rubrics/feature-load-rubric-associations) |
| Assignment Details | [feature-load-assignment-details](https://github.com/Code-with-Ski/Canvas-LMS-Mods/tree/main/canvas-mods/courses/assignments/feature-load-assignment-details) |
| User Enrollments | [feature-enhance-courses-list](https://github.com/Code-with-Ski/Canvas-LMS-Mods/tree/main/canvas-mods/shared-locations/users/feature-enhance-courses-list) |

User Enrollments implements a subset of the original: course-name search, term filter, and course-status filter. The original also shipped course-code search, SIS-ID search, enrollment-status and role dropdowns, and a resizable pane. Its sort order is specific to Canvas Pro-Tools and is not from the original.

## Original work

All other code in Canvas Pro-Tools is original work by Erik Gustafson, released under the ISC License.

[Previous: Changelog]({{ '/changelog/' | relative_url }}){: .mr-4 }
[Next: Support]({{ '/support/' | relative_url }})
