// quiz-nav.js
// Canvas Pro-Tools — Quiz Navigation & Highlighting
// Adapted from original work by James Jones (james@richland.edu)
// Source: https://github.com/jamesjonesmath/canvancement/tree/master/quizzes/grade_by_question
// License: ISC — see CREDITS.md
// Changes: Ported from Tampermonkey userscript to Chrome extension content script.
// Runs in MAIN world to access Canvas page globals (ENV)
// Matches: /courses/*/quizzes/*/history*

(function () {
    'use strict';

    // Must be on the quiz history page
    if (!/^\/courses\/[0-9]+\/quizzes\/[0-9]+\/history$/.test(window.location.pathname)) {
        return;
    }

    // Feature flag — reads data attribute stamped by feature-flags.js (ISOLATED world)
    if (document.documentElement.dataset.cptQuizNav === 'false') return;

    const config = {
        foregroundColor:    '#2D3B45',
        needsReviewColor:   '#BCA6E8',
        needsReviewBorder:  '#6C3BCE',
        incorrectColor:     '#FEF0F1',
        incorrectBorder:    '#F5C1C8',
        unansweredColor:    '#FFFBE5',
        unansweredBorder:   '#E5D5A3',
        // Question types that require human review even if not marked incorrect
        checkQuestionTypes: [
            'essay_question',
            'short_answer_question',
            'fill_in_multiple_blanks_question'
        ]
    };

    // ── Legend ────────────────────────────────────────────────────────────────

    function addLegend() {
        const quizHeader = document.querySelector('.quiz-header');
        if (!quizHeader) return;

        const legend = document.createElement('div');
        legend.id = 'cpt-quiz-nav-legend';
        legend.style.cssText = [
            'padding: 10px',
            'margin-bottom: 10px',
            'border-bottom: 1px solid #ccc',
            'font-size: 12px',
            'background-color: #f5f5f5',
            'font-family: LatoWeb, Lato, "Helvetica Neue", Helvetica, Arial, sans-serif',
            'border-radius: 0.25rem'
        ].join(';');

        const items = [
            { color: config.unansweredColor,  border: config.unansweredBorder,  text: 'Unanswered'   },
            { color: config.incorrectColor,   border: config.incorrectBorder,   text: 'Incorrect'    },
            { color: config.needsReviewColor, border: config.needsReviewBorder, text: 'Needs Review' }
        ];

        legend.innerHTML = items.map(item => `
            <div style="display:inline-block;margin-right:15px;">
                <span style="display:inline-block;width:12px;height:12px;background-color:${item.color};margin-right:5px;border:1px solid ${item.border};vertical-align:middle;"></span>
                <span style="color:#2D3B45;">${item.text}</span>
            </div>
        `).join('');

        quizHeader.parentNode.insertBefore(legend, quizHeader);
    }

    // ── Highlighting ──────────────────────────────────────────────────────────

    function highlightQuestions() {
        const questions = document.querySelectorAll('div#questions div.question.display_question');

        questions.forEach(question => {
            const questionId = question.id.replace('question_', '');
            const navItem    = document.getElementById(`quiz_nav_${questionId}`);
            if (!navItem) return;

            const link = navItem.querySelector('a.question-nav-link');
            if (!link) return;

            link.style.borderRadius = '0.25rem';

            if (question.classList.contains('unanswered')) {
                link.style.backgroundColor = config.unansweredColor;
                link.style.color           = config.foregroundColor;
            } else {
                const needsReview = config.checkQuestionTypes.some(type =>
                    question.classList.contains(type)
                ) && !question.classList.contains('correct');

                if (needsReview) {
                    link.style.backgroundColor = config.needsReviewColor;
                    link.style.color           = config.foregroundColor;
                } else if (question.classList.contains('incorrect')) {
                    link.style.backgroundColor = config.incorrectColor;
                    link.style.color           = config.foregroundColor;
                }
            }
        });
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    function initializeNavigation() {
        const questions = document.querySelectorAll('div#questions div.question.display_question');

        questions.forEach(question => {
            const questionId = question.id.replace('question_', '');
            const navItem    = document.getElementById(`quiz_nav_${questionId}`);
            if (!navItem) return;

            const link = navItem.querySelector('a.question-nav-link');
            if (!link) return;

            link.href = `#${question.id}`;
            link.addEventListener('click', e => {
                e.preventDefault();
                question.scrollIntoView({ behavior: 'smooth', block: 'start' });
                document.querySelectorAll('div#quiz-nav-inner-wrapper ul li')
                    .forEach(item => item.classList.remove('active'));
                navItem.classList.add('active');
            });
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    // Poll until ENV and the question DOM are both ready.
    // Canvas sets ENV as a page global (not window.ENV) and renders questions
    // asynchronously — the script can still beat both at document_idle.

    function waitForReady(attempts) {
        attempts = attempts || 0;
        if (attempts > 40) return; // give up after ~4 seconds

        // Use bare ENV — Canvas sets it as a page global, not always on window
        const envExists      = typeof ENV !== 'undefined' && ENV !== null;
        const questionsReady = document.querySelectorAll(
            'div#questions div.question.display_question'
        ).length > 0;

        if (!envExists || !questionsReady) {
            setTimeout(() => waitForReady(attempts + 1), 100);
            return;
        }

        // If grade-by-question is explicitly disabled, bail out
        if (ENV.GRADE_BY_QUESTION === false) return;

        // ENV exists and questions are in the DOM — run
        initializeNavigation();
        highlightQuestions();
        addLegend();
    }

    waitForReady();

})();
