// cpt-instance.js
// Canvas Pro-Tools - Instance/hostname helper
// Runs in ISOLATED world at document_idle, on all matched Canvas pages.
// Provides a shared way for content scripts to namespace stored data by
// Canvas instance (hostname), so two institutions (e.g. two different
// *.instructure.com subdomains, or a self-hosted Canvas domain) never
// clobber each other's course/rubric/link data even if IDs collide.
//
// Exposes window.CPT_INSTANCE_KEY (string) - e.g. "mobap.instructure.com".
//
// ORDERING CONTRACT: consumers may read CPT_INSTANCE_KEY synchronously at
// top level, but only because Chrome executes the files within a single
// content_scripts block in array order, and this file is listed first in
// every block that registers it. The guarantee is per-block: scripts in
// separate manifest blocks have no defined order relative to each other,
// even at the same run_at.
//
// So any new script that reads CPT_INSTANCE_KEY must be added to a manifest
// block that already lists cpt-instance.js ahead of it. Registering it in a
// block of its own would leave the value undefined at read time, and the
// usual fallback (`window.CPT_INSTANCE_KEY || window.location.hostname`)
// would silently paper over it - correct on the current host, but with the
// namespacing indirection quietly bypassed.
//
// Current consumers, all correctly co-blocked: admin-course-links,
// user-enrollments, gradebook-tracker, speedgrader, checkpoint-mapper,
// rubric-checkpoint-mapper.

(function () {
    'use strict';

    window.CPT_INSTANCE_KEY = window.location.hostname;
})();
