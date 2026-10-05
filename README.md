# Canvas Pro-Tools

A Chrome extension that adds productivity features to the Canvas LMS web
interface for instructors, deans, and administrators. Everything runs locally in
your browser against the Canvas site you are already signed in to.

> **Chrome Web Store:** https://chromewebstore.google.com/detail/canvas-pro-tools/kmknhmanmianmleefcabaocbekjjhplf
>
> If you want to install it locally, see [Installing locally](#install-locally) below. Especially, if you self-host Canvas.

## Features

Each feature can be turned on or off independently from the extension popup.
Features that need setup before they do anything, and features aimed at admins,
ship turned **off** so a fresh install is not noisy.

### For everyone

| Feature | What it does | Default |
|---|---|---|
| 📊 **Gradebook Review Tracker** | Mark and track student submission review status in the gradebook and SpeedGrader. Supports custom review states with your own labels, emoji, and colors. | Off |
| 🔢 **What-If Grades** | Adds a What-If Score column to the instructor view of a student's grades page. Type hypothetical scores, or `EX` to model an excused assignment, and see the impact on current and final grades in real time. | On |
| 📋 **Rubrics+** | Sorts the Find a Rubric dialog by current course, adds CSV export to rubric pages, assignments, discussions, and quizzes, and adds per-rubric export icons plus Import Rubric, Download Template, Export All Rubrics, and Load Rubric Details buttons to the course rubrics list. Flags whether a rubric is actually used for grading. Lets a user edit a locked rubric from the rubric details page. | On |
| 📝 **Assignment Details** | Adds a "Load assignment details" item to the assignments index options menu. Annotates each assignment with its submission type, whether it affects the final grade, and its rubric. External tool assignments show the tool's name, and Classic and New Quizzes are labeled. | On |
| 🗂️ **Checkpoint Rubric Mapper** | For checkpoint-enabled discussions, assign each rubric criterion to a checkpoint. In SpeedGrader, saving the rubric assessment sums the mapped scores into the Reply to Topic and Required Replies grade boxes. | Off |

### SpeedGrader tweaks

| Feature | What it does | Default |
|---|---|---|
| 🧭 **Quiz Nav & Highlighting** | Color-codes quiz navigation links by question status: unanswered, incorrect, or needing manual review (essay, short answer, fill-in-multiple-blanks). | On |
| 🕐 **Graded At Timestamp** | Shows when a submission was graded and whether it was graded manually or automatically. | On |
| 🔍 **Avatar Zoom** | Hover a student's avatar to zoom it to 2x. | Off |

### Dean and admin

| Feature | What it does | Default |
|---|---|---|
| 🔗 **Admin Course Links** | Adds configurable quick-access links beneath each course in the admin course search results. | Off |
| 🎓 **User Enrollments** | Adds a search box plus term and course-status filters to the Courses list on a user's page, and re-sorts it so active enrollments come first. | Off |

## Install Locally

1. Download or clone the canvas-pro-tools folder in this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.

The extension activates on `*.instructure.com` pages only. However, you can change it to run on any domain if you edit the files. A feature to allow for self-hosted domains or custom domains will be coming. 

## Privacy

Canvas Pro-Tools does not collect, transmit, sell, or share any data. There is
no server, no analytics, and no telemetry. Settings and review markers are kept
in your browser's local extension storage on your own device, and are separated
by Canvas site so data from different institutions never mixes. Student names,
email addresses, grades, and submitted work are never stored.

Full details in [PRIVACY.md](canvas-pro-tools/PRIVACY.md).

## Compatibility

Built for Chrome and Chromium-based browsers using Manifest V3. Works with
Canvas instances hosted on `*.instructure.com`. Self-hosted Canvas domains are
not currently supported.

## Credits

Several features are adapted from two open-source projects, with thanks to their
authors:

- **[Canvancement](https://github.com/jamesjonesmath/canvancement)** by James
  Jones, under the ISC License
- **[Canvas-LMS-Mods](https://github.com/Code-with-Ski/Canvas-LMS-Mods)** by
  James Sekcienski (Code with Ski), under the MIT License

Per-feature attribution, including which behaviour was adapted and what was
changed, is in [CREDITS.md](canvas-pro-tools/CREDITS.md).

## License

ISC. See [LICENSE](canvas-pro-tools/CREDITS.md).

Adapted work from the projects above remains under its original license.
