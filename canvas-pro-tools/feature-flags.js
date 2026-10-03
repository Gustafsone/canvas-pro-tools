// feature-flags.js
// Canvas Pro-Tools — Feature flag bridge
// Runs in ISOLATED world (default). Reads feature toggles from chrome.storage
// and stamps them as data-* attributes on <html> so MAIN world scripts
// (quiz-nav.js, rubric-sorter.js) can read them without chrome.* API access.
// ISOLATED world scripts registered on the same match patterns
// (rubric-exporter.js, rubric-info.js) read the same data-* attributes rather
// than calling chrome.storage themselves — one read, one shape, no races.

(function () {
    'use strict';

    const FEATURES_KEY = 'cpt_features';

    // Must stay in step with the FEATURES array in popup.js. These apply only
    // when a feature has never been toggled on this Canvas instance.
    //
    // IMPORTANT: only three of these actually drive anything. The stamps for
    // quizNav, rubricPlus, and assignmentDetails are read by quiz-nav.js,
    // {rubric-exporter,rubric-info,rubric-sorter}.js, and assignment-details.js
    // respectively. The other six are stamped but read by nobody — those
    // features check chrome.storage directly in their own content scripts, and
    // THAT is where their effective default lives:
    //   reviewTracker    -> gradebook-tracker.js, speedgrader.js
    //   sgAvatarZoom     -> sg-avatar-zoom.js
    //   adminCourseLinks -> admin-course-links.js
    //   sgGradedAt       -> graded-at.js
    //   whatIfGrades     -> what-if-grades.js
    //   checkpointMapper -> checkpoint-mapper.js, rubric-checkpoint-mapper.js
    // They are kept in sync here so the three copies of each default do not
    // contradict each other, but changing one of the six here alone has no
    // runtime effect. Change the owning content script too.
    const DEFAULTS = {
        reviewTracker:    false,
        quizNav:          true,
        rubricPlus:       true,
        assignmentDetails: true,
        sgAvatarZoom:     false,
        sgGradedAt:       true,
        adminCourseLinks: false,
        whatIfGrades:     true,
        checkpointMapper: false,
    };

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        const all = (result && result[FEATURES_KEY]) || {};

        // chrome.storage.local[FEATURES_KEY] is namespaced per Canvas
        // instance (hostname): { "<hostname>": { reviewTracker: true, ... } }.
        // If the top-level object still has the legacy flat shape (boolean
        // toggles directly at the top), use it as-is — popup.js performs
        // the on-disk migration to the namespaced shape.
        const looksLegacy = Object.keys(all).some(function (k) {
            return typeof all[k] === 'boolean';
        });
        const saved = looksLegacy ? all : (all[window.location.hostname] || {});

        const features = {};

        Object.keys(DEFAULTS).forEach(function (key) {
            features[key] = typeof saved[key] === 'boolean' ? saved[key] : DEFAULTS[key];
        });

        const html = document.documentElement;
        html.dataset.cptQuizNav          = features.quizNav          ? 'true' : 'false';
        html.dataset.cptRubricPlus       = features.rubricPlus       ? 'true' : 'false';
        html.dataset.cptAssignmentDetails = features.assignmentDetails ? 'true' : 'false';
        html.dataset.cptReviewTracker    = features.reviewTracker    ? 'true' : 'false';
        html.dataset.cptSgAvatarZoom     = features.sgAvatarZoom     ? 'true' : 'false';
        html.dataset.cptSgGradedAt       = features.sgGradedAt       ? 'true' : 'false';
        html.dataset.cptAdminCourseLinks = features.adminCourseLinks ? 'true' : 'false';
        html.dataset.cptWhatIfGrades     = features.whatIfGrades     ? 'true' : 'false';
        html.dataset.cptCheckpointMapper = features.checkpointMapper ? 'true' : 'false';
    });

})();
