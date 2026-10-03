// sg-avatar-zoom.js
// Canvas Pro-Tools — SpeedGrader Avatar Zoom
// Adapted from original work by James Jones (james@richland.edu)
// Source: https://github.com/jamesjonesmath/canvancement/blob/master/miscellaneous/canvas-css-tweaks.user.js
// License: ISC — see CREDITS.md
// Runs in ISOLATED world — can access chrome.storage directly.
// Matches: /courses/*/gradebook/speed_grader*

(function () {
    'use strict';

    // Only run on SpeedGrader
    if (!/^\/courses\/\d+\/gradebook\/speed_grader$/.test(window.location.pathname)) {
        return;
    }

    const FEATURES_KEY = 'cpt_features';

    // Must match FEATURES in popup.js and DEFAULTS in feature-flags.js.
    // Default OFF: this is a cosmetic preference rather than a problem being
    // solved, and it changes how student photos behave while grading, which is
    // a choice the grader should make deliberately rather than inherit.
    const DEFAULTS = {
        sgAvatarZoom: false,
    };

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        const allFeatures = (result && result[FEATURES_KEY]) || {};
        const featLegacy  = Object.keys(allFeatures).some(k => typeof allFeatures[k] === 'boolean');
        const saved     = featLegacy ? allFeatures : (allFeatures[window.location.hostname] || {});
        const features  = {};

        Object.keys(DEFAULTS).forEach(function (key) {
            features[key] = typeof saved[key] === 'boolean' ? saved[key] : DEFAULTS[key];
        });

        const rules = [];

        // ── Avatar zoom ───────────────────────────────────────────────────────
        // Hovering over a student's avatar in SpeedGrader scales it to 2x,
        // making it easier to identify students by photo.
        if (features.sgAvatarZoom) {
            // Classic SpeedGrader. Retained until Canvas completes the forced
            // rollout of the new SpeedGrader — non-matching selectors are inert,
            // so both eras can coexist with no branching or DOM probing.
            rules.push('.gradebookAvatar { transition: transform 0.15s ease; }');
            rules.push('.gradebookAvatar:hover { transform: scale(2); z-index: 999; position: relative; }');

            // New SpeedGrader. Two things differ from classic, both verified
            // against the live DOM rather than assumed:
            //
            // 1. The avatar is an InstUI <Avatar> rendered as a <span> (not an
            //    <img>), and it is decoration INSIDE the student picker button
            //    — not a standalone photo as in classic SpeedGrader.
            //    Chain: SPAN[student-avatar] < SPAN×3 < DIV×2 < BUTTON[student-select-trigger]
            //
            // 2. That span has pointer-events:none, so [data-testid="student-avatar"]:hover
            //    can NEVER fire — InstUI makes it inert so it doesn't steal the
            //    button's hit target. elementFromPoint at the avatar's centre
            //    returns the BUTTON, not the avatar.
            //
            // So: hover the button, scale the descendant avatar. pointer-events
            // on the avatar is then irrelevant — the button is the hover target
            // and the avatar is only styled as a descendant.
            //
            // Both selectors use data-testid rather than the Emotion hash
            // classes (css-b3m9pr-…, css-arm9qw-…), which change whenever
            // InstUI's style objects change and would break on a Canvas deploy.
            //
            // Kept separate from the classic pair: the two eras now have
            // genuinely different selectors, not just different names.
            rules.push('[data-testid="student-avatar"] { transition: transform 0.15s ease; }');
            rules.push('[data-testid="student-select-trigger"]:hover [data-testid="student-avatar"] { transform: scale(2); z-index: 999; position: relative; }');
        }

        if (rules.length === 0) return;

        const style = document.createElement('style');
        style.id    = 'cpt-sg-avatar-zoom';
        document.head.appendChild(style);
        rules.forEach(function (rule, i) {
            style.sheet.insertRule(rule, i);
        });
    });

})();
