// what-if-grades.js
// Canvas Pro-Tools — Instructor What-If Grades
// Runs in ISOLATED world — can access chrome.storage directly.
// Matches: /courses/*/grades/:studentId
//
// Scrapes all assignment and group data from the existing DOM.
// No API calls are made. Grade calculation is performed locally.
//
// UI: Inserts a dedicated "What-If Score" column into the grades table,
//     immediately after the existing Score column (detected dynamically).
//   - Assignment rows  → editable number input; original score stays visible
//   - 0-point rows     → input allowed (extra credit scenarios)
//   - Group total rows → recalculated group % (current + final)
//   - Final grade row  → recalculated current + final course grades
//
// Calculation rules:
//   Current grade  — only graded assignments (or rows with a what-if score)
//                    count; groups with no such work excluded from weighting.
//   Final grade    — ungraded assignments count as zero; groups with no
//                    scoreable assignments excluded from weighting.
//   Weighted       — sum(group% × weight) / sum(active group weights)
//   Unweighted     — sum(earned) / sum(possible)

(function () {
    'use strict';

    // =========================================================================
    // GUARD — instructor view of a student grades page only.
    // /courses/:id/grades/:studentId   ← instructor view
    // /courses/:id/grades              ← student's own view (no user segment)
    // =========================================================================

    if (!/\/courses\/\d+\/grades\/\d+/.test(window.location.pathname)) return;

    const FEATURES_KEY = 'cpt_features';

    chrome.storage.local.get(FEATURES_KEY, function (result) {
        // cpt_features is namespaced per Canvas instance (hostname), with a
        // legacy flat-shape fallback until popup.js migrates it on disk.
        const allFeatures = (result && result[FEATURES_KEY]) || {};
        const featLegacy  = Object.keys(allFeatures).some(k => typeof allFeatures[k] === 'boolean');
        const saved   = featLegacy ? allFeatures : (allFeatures[window.location.hostname] || {});
        const enabled = typeof saved.whatIfGrades === 'boolean' ? saved.whatIfGrades : true;
        if (!enabled) return;
        waitForTable();
    });

    // =========================================================================
    // WAIT FOR TABLE
    // =========================================================================

    function waitForTable(attempt) {
        attempt = attempt || 0;
        const tbl = document.getElementById('grades_summary');
        if (tbl) { initialize(tbl); return; }
        if (attempt < 10) setTimeout(function () { waitForTable(attempt + 1); }, 500);
    }

    // =========================================================================
    // STATE
    // =========================================================================

    var assignments  = [];
    var groups       = {};
    var tableEl      = null;
    var isActive     = false;
    var groupCells   = {};   // groupId → { currentEl, finalEl }
    var finalCells   = null; // { currentEl, finalEl }
    var scoreColIndex = -1;  // detected at runtime

    // =========================================================================
    // STYLING CONSTANTS
    // =========================================================================

    var CANVAS_FONT  = 'LatoWeb, Lato, "Helvetica Neue", Helvetica, Arial, sans-serif';
    var COLOR_BLUE   = '#0770a3';
    var COLOR_TEXT   = '#2D3B45';
    var COLOR_MUTED  = '#556572';
    var COLOR_BORDER = '#c7cdd1';
    var COLOR_GREEN  = '#0b874b';
    var COLOR_ORANGE = '#C23B22';
    var COLOR_COLBG  = '#eaf4fb';

    // =========================================================================
    // DETECT SCORE COLUMN INDEX
    // Finds the <th> whose text content is "Score" (case-insensitive) in the
    // thead and returns its 0-based index among sibling cells.
    // Falls back to index 4 if not found (matches known Canvas DOM structure).
    // =========================================================================

    function detectScoreColumnIndex() {
        const thead = tableEl.querySelector('thead tr');
        if (!thead) return 4;

        const ths = Array.from(thead.children);
        for (var i = 0; i < ths.length; i++) {
            const text = ths[i].textContent.trim().toLowerCase();
            if (text === 'score') return i;
        }
        return 4; // safe fallback
    }

    // =========================================================================
    // SCRAPE
    // =========================================================================

    function scrape() {
        assignments = [];
        groups      = {};

        // ── Assignment rows ───────────────────────────────────────────────────
        const rows = tableEl.querySelectorAll('tr.student_assignment.editable:not(.hard_coded)');
        rows.forEach(function (row) {
            const scoreHolder = row.querySelector('.score_holder');
            if (!scoreHolder) return;

            const groupId      = getText(scoreHolder, '.assignment_group_id');
            const assignmentId = getText(scoreHolder, '.assignment_id');
            if (!groupId || !assignmentId) return;

            // Points possible — "/ N" span inside .tooltip
            const possibleSpan = row.querySelector('.tooltip > span:last-child');
            const possibleText = possibleSpan ? possibleSpan.textContent.replace('/', '').trim() : '';
            const pointsPossible = parseFloat(possibleText);
            if (isNaN(pointsPossible)) return;

            // Score — prefer .original_points (float), fall back to .original_score
            const opText = getText(scoreHolder, '.original_points');
            const osText = getText(scoreHolder, '.original_score');
            let originalScore = null;
            if (opText !== '') {
                const v = parseFloat(opText);
                if (!isNaN(v)) originalScore = v;
            } else if (osText !== '') {
                const v = parseFloat(osText);
                if (!isNaN(v)) originalScore = v;
            }

            const status  = getText(scoreHolder, '.submission_status').toLowerCase();
            const titleEl = row.querySelector('.title a');
            const name    = titleEl ? titleEl.textContent.trim() : assignmentId;

            const assignment = {
                id:             assignmentId,
                groupId:        groupId,
                name:           name,
                originalScore:  originalScore,
                pointsPossible: pointsPossible,
                status:         status,
                whatIfScore:    null,
                row:            row,
            };

            assignments.push(assignment);

            if (!groups[groupId]) {
                groups[groupId] = { id: groupId, name: '', weight: 0, assignments: [], row: null };
            }
            groups[groupId].assignments.push(assignment);
        });

        // ── Group total rows (name + weight + row ref) ────────────────────────
        const groupRows = tableEl.querySelectorAll('tr.group_total');
        groupRows.forEach(function (row) {
            const scoreHolder = row.querySelector('.score_holder');
            if (!scoreHolder) return;

            const groupId = getText(scoreHolder, '.assignment_group_id');
            if (!groupId || !groups[groupId]) return;

            const weightText = getText(scoreHolder, '.group_weight');
            const weight     = parseFloat(weightText);
            const titleEl    = row.querySelector('th.title');
            const name       = titleEl ? titleEl.textContent.trim() : groupId;

            groups[groupId].name   = name;
            groups[groupId].weight = isNaN(weight) ? 0 : weight;
            groups[groupId].row    = row;
        });
    }

    function getText(parent, selector) {
        const el = parent.querySelector(selector);
        return el ? el.textContent.trim() : '';
    }

    // =========================================================================
    // GRADE CALCULATION
    // =========================================================================

    function effectiveScore(a) {
        if (a.whatIfScore === 'EXCUSED') return null;
        return a.whatIfScore !== null ? a.whatIfScore : a.originalScore;
    }

    function isExcused(a) {
        return a.whatIfScore === 'EXCUSED';
    }

    function isWeightedCourse() {
        return Object.values(groups).some(function (g) { return g.weight > 0; });
    }

    function calculateGrades() {
        return isWeightedCourse() ? calculateWeighted() : calculateUnweighted();
    }

    function calculateWeighted() {
        var currentWeightSum = 0, currentPoints = 0;
        var finalWeightSum   = 0, finalPoints   = 0;
        var groupResults     = {};

        Object.values(groups).forEach(function (group) {
            const result = { currentPct: null, finalPct: null };

            if (group.weight > 0) {
                // For current grade: all assignments are scoreable (0-point ones
                // can receive extra credit via what-if input).
                // For final grade: only assignments with pointsPossible > 0 count
                // toward the denominator; 0-point what-if scores are additive.
                const allAssignments = group.assignments;

                // ── Current ──────────────────────────────────────────────────
                // Include if: graded, OR has a what-if score entered.
                // Exclude if: marked EX (excused) — dropped from both earned and possible.
                const counted = allAssignments.filter(function (a) {
                    if (isExcused(a)) return false;
                    return a.status === 'graded' || effectiveScore(a) !== null;
                });
                if (counted.length > 0) {
                    const earned   = counted.reduce(function (s, a) { return s + (effectiveScore(a) || 0); }, 0);
                    // Denominator: only assignments with pointsPossible > 0.
                    // 0-point assignments add to the numerator only (extra credit).
                    const possible = counted.reduce(function (s, a) {
                        return s + (a.pointsPossible > 0 ? a.pointsPossible : 0);
                    }, 0);
                    if (possible > 0) {
                        result.currentPct  = (earned / possible) * 100;
                        currentPoints     += result.currentPct * group.weight;
                        currentWeightSum  += group.weight;
                    }
                }

                // ── Final ─────────────────────────────────────────────────────
                // Excused assignments are dropped from both earned and possible.
                const scoreable = allAssignments.filter(function (a) { return a.pointsPossible > 0 && !isExcused(a); });
                if (scoreable.length > 0) {
                    const fEarned   = scoreable.reduce(function (s, a) {
                        const sc = effectiveScore(a);
                        return s + (sc !== null ? sc : 0);
                    }, 0);
                    const fPossible = scoreable.reduce(function (s, a) { return s + a.pointsPossible; }, 0);
                    if (fPossible > 0) {
                        result.finalPct  = (fEarned / fPossible) * 100;
                        finalPoints     += result.finalPct * group.weight;
                        finalWeightSum  += group.weight;
                    }
                }
            }

            groupResults[group.id] = result;
        });

        return {
            groupResults: groupResults,
            currentGrade: currentWeightSum > 0 ? currentPoints / currentWeightSum : null,
            finalGrade:   finalWeightSum   > 0 ? finalPoints   / finalWeightSum   : null,
        };
    }

    function calculateUnweighted() {
        var currentEarned = 0, currentPossible = 0;
        var finalEarned   = 0, finalPossible   = 0;
        var groupResults  = {};

        Object.values(groups).forEach(function (group) {
            var gCE = 0, gCP = 0, gFE = 0, gFP = 0;

            group.assignments.forEach(function (a) {
                if (isExcused(a)) return; // excused — drop from both earned and possible
                const score = effectiveScore(a);

                // Current — graded or has what-if score
                if (a.status === 'graded' || score !== null) {
                    const earned = score || 0;
                    // 0-point assignments: add to numerator only (extra credit).
                    gCE += earned;
                    currentEarned += earned;
                    if (a.pointsPossible > 0) {
                        gCP += a.pointsPossible;
                        currentPossible += a.pointsPossible;
                    }
                }

                // Final — pointsPossible > 0 only
                if (a.pointsPossible > 0) {
                    gFE += (score !== null ? score : 0);
                    gFP += a.pointsPossible;
                    finalEarned   += (score !== null ? score : 0);
                    finalPossible += a.pointsPossible;
                }
            });

            groupResults[group.id] = {
                currentPct: gCP > 0 ? (gCE / gCP) * 100 : null,
                finalPct:   gFP > 0 ? (gFE / gFP) * 100 : null,
            };
        });

        return {
            groupResults: groupResults,
            currentGrade: currentPossible > 0 ? (currentEarned / currentPossible) * 100 : null,
            finalGrade:   finalPossible   > 0 ? (finalEarned   / finalPossible)   * 100 : null,
        };
    }

    // =========================================================================
    // FORMAT HELPERS
    // =========================================================================

    function formatPct(pct) {
        if (pct === null) return 'N/A';
        return pct.toFixed(2) + '%';
    }

    function gradeColor(pct) {
        if (pct === null) return COLOR_MUTED;
        return pct >= 70 ? COLOR_GREEN : COLOR_ORANGE;
    }

    // =========================================================================
    // COLUMN INJECTION
    // =========================================================================

    function injectColumn() {
        groupCells = {};
        finalCells = null;

        // ── Header ────────────────────────────────────────────────────────────
        const thead = tableEl.querySelector('thead tr');
        if (!thead) return;

        const th = document.createElement('th');
        th.className    = 'cpt-what-if-col assignment_score';
        th.scope        = 'col';
        th.textContent  = 'What-If Score';
        th.style.cssText = [
            'background:' + COLOR_COLBG,
            'color:' + COLOR_BLUE,
            'font-size:13px',
            'font-weight:bold',
            'white-space:nowrap',
            'padding:6px 8px',
            'border-bottom:2px solid ' + COLOR_BLUE,
            'cursor:default',
            'width:100px',
            'min-width:100px',
            'max-width:100px',
        ].join(';');

        insertAfterIndex(thead, th, scoreColIndex);

        // ── Assignment rows ───────────────────────────────────────────────────
        assignments.forEach(function (assignment) {
            const td = document.createElement('td');
            td.className    = 'cpt-what-if-col assignment_score';
            td.style.cssText = [
                'background:' + COLOR_COLBG,
                'vertical-align:middle',
                'padding:4px 8px',
                'width:100px',
                'min-width:100px',
                'max-width:100px',
                'box-sizing:border-box',
            ].join(';');

            const input = document.createElement('input');
            input.type        = 'text';
            input.placeholder = assignment.originalScore !== null
                ? String(assignment.originalScore)
                : (assignment.pointsPossible === 0 ? 'extra credit' : '—');
            input.title       = assignment.name +
                (assignment.pointsPossible > 0
                    ? ' (out of ' + assignment.pointsPossible + ' — type EX to excuse)'
                    : ' (0-point — extra credit only)');
            input.className   = 'cpt-what-if-input';
            input.style.cssText = [
                'width:72px',
                'padding:3px 5px',
                'font-family:' + CANVAS_FONT,
                'font-size:13px',
                'border:1px solid ' + COLOR_BLUE,
                'border-radius:3px',
                'color:' + COLOR_TEXT,
                'background:#fff',
                'box-sizing:border-box',
            ].join(';');

            // Italicise placeholder on 0-point rows to signal extra-credit nature
            if (assignment.pointsPossible === 0) {
                input.style.fontStyle = 'italic';
            }

            input.addEventListener('input', function () {
                const val     = input.value.trim().toUpperCase();
                const isEx    = val === 'EX';
                const parsed  = parseFloat(input.value);

                if (isEx) {
                    assignment.whatIfScore    = 'EXCUSED';
                    input.value               = 'EX';
                    input.style.fontStyle     = 'italic';
                    input.style.color         = COLOR_BLUE;
                    input.style.fontWeight    = 'bold';
                } else if (input.value.trim() === '' || isNaN(parsed)) {
                    assignment.whatIfScore    = null;
                    input.style.fontStyle     = 'normal';
                    input.style.color         = COLOR_TEXT;
                    input.style.fontWeight    = 'normal';
                } else {
                    assignment.whatIfScore    = parsed;
                    input.style.fontStyle     = 'normal';
                    input.style.color         = COLOR_TEXT;
                    input.style.fontWeight    = 'normal';
                }

                updateColumn();
                const resetBtn = document.getElementById('cpt-what-if-reset');
                if (resetBtn) resetBtn.style.display = 'inline-block';
            });

            td.appendChild(input);
            insertAfterIndex(assignment.row, td, scoreColIndex);
        });

        // ── Group total rows ──────────────────────────────────────────────────
        Object.values(groups).forEach(function (group) {
            if (!group.row) return;

            const td = buildSummaryTd();
            const currentLine = buildValueLine('Current:', null);
            const finalLine   = buildValueLine('Final:',   null);
            td.appendChild(currentLine.wrap);
            td.appendChild(finalLine.wrap);

            insertAfterIndex(group.row, td, scoreColIndex);

            groupCells[group.id] = {
                currentEl: currentLine.valueEl,
                finalEl:   finalLine.valueEl,
            };
        });

        // ── Expand colspans on hidden detail/comment rows ─────────────────────
        tableEl.querySelectorAll('tr.comments').forEach(function (row) {
            row.querySelectorAll('td[colspan]').forEach(function (cell) {
                const span = parseInt(cell.getAttribute('colspan'), 10);
                if (!isNaN(span)) cell.setAttribute('colspan', String(span + 1));
            });
        });

        // ── Final grade row ───────────────────────────────────────────────────
        const finalRow = tableEl.querySelector('tr.final_grade');
        if (finalRow) {
            const td = buildSummaryTd();
            td.style.fontWeight = 'bold';
            const currentLine = buildValueLine('Current:', null);
            const finalLine   = buildValueLine('Final:',   null);
            td.appendChild(currentLine.wrap);
            td.appendChild(finalLine.wrap);

            insertAfterIndex(finalRow, td, scoreColIndex);

            finalCells = {
                currentEl: currentLine.valueEl,
                finalEl:   finalLine.valueEl,
            };
        }

        // Populate immediately with baseline values (no what-if scores yet)
        updateColumn();
    }

    function buildSummaryTd() {
        const td = document.createElement('td');
        td.className    = 'cpt-what-if-col assignment_score';
        td.style.cssText = [
            'background:' + COLOR_COLBG,
            'padding:4px 8px',
            'vertical-align:middle',
            'font-family:' + CANVAS_FONT,
            'font-size:13px',
            'width:100px',
            'min-width:100px',
            'max-width:100px',
            'box-sizing:border-box',
        ].join(';');
        return td;
    }

    function buildValueLine(label, pct) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:4px;align-items:baseline;line-height:1.5;';

        const labelEl = document.createElement('span');
        labelEl.textContent   = label;
        labelEl.style.cssText = 'font-size:11px;color:' + COLOR_MUTED + ';white-space:nowrap;';

        const valueEl = document.createElement('span');
        valueEl.textContent   = formatPct(pct);
        valueEl.style.cssText = 'font-weight:bold;color:' + gradeColor(pct) + ';';

        wrap.appendChild(labelEl);
        wrap.appendChild(valueEl);

        return { wrap: wrap, valueEl: valueEl };
    }

    // Insert cell immediately after the cell at afterIndex (0-based)
    function insertAfterIndex(row, cell, afterIndex) {
        const insertBefore = row.children[afterIndex + 1] || null;
        row.insertBefore(cell, insertBefore);
    }

    function removeColumn() {
        tableEl.querySelectorAll('.cpt-what-if-col').forEach(function (el) { el.remove(); });

        // Restore colspans
        tableEl.querySelectorAll('tr.comments').forEach(function (row) {
            row.querySelectorAll('td[colspan]').forEach(function (cell) {
                const span = parseInt(cell.getAttribute('colspan'), 10);
                if (!isNaN(span) && span > 1) cell.setAttribute('colspan', String(span - 1));
            });
        });

        groupCells = {};
        finalCells = null;
    }

    // =========================================================================
    // UPDATE — recalculate and refresh all summary cells
    // =========================================================================

    function updateColumn() {
        const result = calculateGrades();

        Object.values(groups).forEach(function (group) {
            const cells = groupCells[group.id];
            if (!cells) return;
            const gr = result.groupResults[group.id] || { currentPct: null, finalPct: null };
            setValueEl(cells.currentEl, gr.currentPct);
            setValueEl(cells.finalEl,   gr.finalPct);
        });

        if (finalCells) {
            setValueEl(finalCells.currentEl, result.currentGrade);
            setValueEl(finalCells.finalEl,   result.finalGrade);
        }
    }

    function setValueEl(el, pct) {
        el.textContent = formatPct(pct);
        el.style.color = gradeColor(pct);
    }

    // =========================================================================
    // RESET
    // =========================================================================

    function resetAll() {
        assignments.forEach(function (a) { a.whatIfScore = null; });
        tableEl.querySelectorAll('.cpt-what-if-input').forEach(function (el) {
            el.value            = '';
            el.style.fontStyle  = 'normal';
            el.style.color      = COLOR_TEXT;
            el.style.fontWeight = 'normal';
        });
        const resetBtn = document.getElementById('cpt-what-if-reset');
        if (resetBtn) resetBtn.style.display = 'none';
        updateColumn();
    }

    // =========================================================================
    // PANEL
    // =========================================================================

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'cpt-what-if-panel';
        panel.style.cssText = [
            'margin-bottom:0.75rem',
            'display:flex',
            'flex-direction:column',
            'align-items:flex-start',
            'gap:0.25rem',
            'font-family:' + CANVAS_FONT,
        ].join(';');

        const toggleBtn = document.createElement('button');
        toggleBtn.id          = 'cpt-what-if-toggle';
        toggleBtn.textContent = '📊 What-If Grades';
        styleButton(toggleBtn, false);

        const hintEl = document.createElement('span');
        hintEl.style.cssText = [
            'display:none',
            'font-size:12px',
            'color:' + COLOR_MUTED,
            'font-style:italic',
        ].join(';');
        hintEl.textContent = 'Type a score or EX (excused) in the What-If Score column to see the grade impact.';

        const defEl = document.createElement('span');
        defEl.style.cssText = [
            'font-size:11px',
            'color:' + COLOR_MUTED,
            'display:none',
            'margin-top:4px',
        ].join(';');
        defEl.innerHTML = '<strong>Current</strong> = graded assignments only &nbsp;·&nbsp; <strong>Final</strong> = all assignments (ungraded &amp; unsubmitted = 0)';

        toggleBtn.addEventListener('click', function () {
            isActive = !isActive;
            styleButton(toggleBtn, isActive);
            hintEl.style.display  = isActive ? 'inline' : 'none';
            defEl.style.display   = isActive ? 'block'  : 'none';

            if (isActive) {
                injectColumn();
            } else {
                assignments.forEach(function (a) { a.whatIfScore = null; });
                removeColumn();
                const resetBtn = document.getElementById('cpt-what-if-reset');
                if (resetBtn) resetBtn.style.display = 'none';
            }
        });

        const resetBtn = document.createElement('button');
        resetBtn.id          = 'cpt-what-if-reset';
        resetBtn.textContent = '↺ Reset';
        resetBtn.style.cssText = [
            'display:none',
            'padding:5px 10px',
            'font-family:' + CANVAS_FONT,
            'font-size:12px',
            'color:' + COLOR_TEXT,
            'background:#fff',
            'border:1px solid ' + COLOR_BORDER,
            'border-radius:3px',
            'cursor:pointer',
        ].join(';');
        resetBtn.addEventListener('click', resetAll);

        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;';
        buttonRow.appendChild(toggleBtn);
        buttonRow.appendChild(resetBtn);
        buttonRow.appendChild(hintEl);

        panel.appendChild(buttonRow);
        panel.appendChild(defEl);

        return panel;
    }

    function styleButton(btn, active) {
        btn.style.cssText = [
            'padding:6px 12px',
            'font-family:' + CANVAS_FONT,
            'font-size:13px',
            'font-weight:bold',
            'border-radius:3px',
            'cursor:pointer',
            'border:1px solid ' + (active ? COLOR_BLUE : COLOR_BORDER),
            'background:' + (active ? COLOR_BLUE : '#fff'),
            'color:' + (active ? '#fff' : COLOR_TEXT),
        ].join(';');
    }

    // =========================================================================
    // INITIALIZE
    // =========================================================================

    function initialize(tbl) {
        if (document.getElementById('cpt-what-if-panel')) return;
        tableEl       = tbl;
        scoreColIndex = detectScoreColumnIndex();
        scrape();
        const panel = buildPanel();
        tableEl.parentElement.insertBefore(panel, tableEl);
    }

})();
