---
title: Admin and dean tools
parent: Features
nav_order: 3
permalink: /features/admin/
description: Admin Course Links and User Enrollments, two tools for people who work across many courses.
---

# Admin and dean tools

Two tools for people who work across many courses. Both start switched off, since most instructors never visit the pages they change. Turn them on in the popup's **Tools** tab.

1. TOC
{:toc}

## Admin Course Links

Off by default. **Where:** the course search results in an account's admin pages.

Adds a row of quick-access links beneath each course in the results, so you can jump straight to a course's Assignments, Grades, or People without opening the course first. You choose which links appear, and in what order, in the popup's **Links** tab.

{: .screenshot }
> [SCREENSHOT: admin course search results with quick links under each course]

### Built-in links

| Shown by default | Available, switched off |
|---|---|
| Assignments, Modules, People, Grades, Files, Syllabus | Settings, Announcements, Discussions, Outcomes, Pages, Quizzes |

### Customize the list

- Turn links on or off with the toggles in the Links tab.
- Reorder with the up and down buttons. Built-in and custom links share one list, so you can mix their order.
- Add a custom link with the **Add Custom Tool Link** form at the bottom of the tab. Enter a label and paste a full Canvas course URL, including an external tool URL. The extension keeps the course-relative part of the address and applies it to every course in the results.
- Remove a custom link with its X button. Built-in links cannot be deleted, only switched off.

Adapted from Canvancement's admin-course-links. See [Credits]({{ '/credits/' | relative_url }}).

## User Enrollments

Off by default. **Where:** a user's page in Canvas, including your own.

Makes a long Courses list on a user's page easier to use. It adds a course name search box, a term filter, and a course status filter, plus a count of how many enrollments are showing. Useful on accounts with long enrollment histories.

### How the list is sorted

1. Enrollment status: Active first, then Completed, then Inactive.
2. Courses in the Default Term.
3. Courses in named terms that are not dated, such as Master Templates, in alphabetical order.
4. Courses in dated terms, newest first.
5. Role, as a final tiebreaker.

{: .important }
> **Check your term names.** A term counts as dated when its name is two letters, a hyphen, and two digits, such as FA-26 or SP-21. Terms named any other way are sorted with the named terms.

{: .confirm }
> Add wording for institutions whose term names follow a different pattern, and decide whether a setting for this is wanted later.

The tool works only with what is already on the page and makes no extra requests to Canvas. It covers the search box and the two filters from the original it was adapted from. See [Credits]({{ '/credits/' | relative_url }}).

[Previous: In SpeedGrader]({{ '/features/speedgrader/' | relative_url }}){: .mr-4 }
[Next: Outcome Map]({{ '/features/outcome-map/' | relative_url }})
