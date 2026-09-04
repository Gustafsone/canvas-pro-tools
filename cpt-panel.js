// cpt-panel.js
// Canvas Pro-Tools — shared panel design system
// Provides the shared "details panel" used by Assignment Details and Rubrics+:
// a white card with a hairline border, a muted collapsible header, and a
// label/value grid. Colors meet WCAG 2.1 AA contrast on the white panel:
// header #5f6b73 (5.47:1), muted #4a6070 (6.57:1), accent #0770a3 (5.45:1),
// success #166b3a (6.57:1), warning #7a4f00 (7.13:1), text #2d3b45 (11.52:1).
// The #c7cdd1 border is decorative grouping, not a control boundary, and
// matches Canvas's own border tone.
//
// Loaded (via manifest) before any consumer in the same content-script block.
// Content scripts from the same extension in the same frame/world share a
// global scope, so the top-level CPTPanel object below is visible to the files
// listed after it — the same pattern Canvas-LMS-Mods uses for its util classes.
//
// Runs in ISOLATED world (default). No window.ENV or page jQuery needed.

var CPTPanel = (function () {
    "use strict";

    var COLORS = {
        accent:   '#0770a3', // links (matches Canvas link blue)
        accentBg: '#e8f4fb', // pale blue tint (retained; no longer the panel fill)
        surface:  '#ffffff', // panel fill — white card
        border:   '#c7cdd1', // hairline card border (Canvas's own border tone)
        header:   '#5f6b73', // panel header label (5.47:1 on white)
        success:  '#166b3a', // AA-safe green  (6.57:1 on white)
        warning:  '#7a4f00', // AA-safe amber  (7.13:1 on white)
        muted:    '#4a6070', // row labels     (6.57:1 on white)
        text:     '#2d3b45'  // values / body (11.52:1 on white)
    };

    var PANEL_CLASS    = 'cpt-details-panel';
    var GRID_CLASS     = 'cpt-details-grid';
    var HEADER_CLASS   = 'cpt-details-header';
    var CARET_CLASS    = 'cpt-details-caret';
    var COLLAPSED_ATTR = 'data-cpt-collapsed';
    var STYLE_ID       = 'cpt-panel-style';
    var SPIN_CLASS     = 'cpt-panel-spin';

    // ── One-time style injection ──────────────────────────────────────────────
    // Spin keyframe (for loading indicators), caret rotation, and the collapse
    // rules. The grid/header collapse rules use !important to beat the inline
    // display:grid / margin the panel sets on those elements. Guarded by id so
    // repeated calls don't stack duplicate <style> tags.

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '@keyframes cptPanelSpin{to{transform:rotate(360deg)}}' +
            '.' + SPIN_CLASS + '{display:inline-block;animation:cptPanelSpin 0.8s linear infinite;}' +
            '.' + HEADER_CLASS + '{cursor:pointer;user-select:none;}' +
            '.' + CARET_CLASS + '{transition:transform 0.15s ease;}' +
            '.' + PANEL_CLASS + '[' + COLLAPSED_ATTR + '="true"] .' + CARET_CLASS +
                '{transform:rotate(-90deg);}' +
            '.' + PANEL_CLASS + '[' + COLLAPSED_ATTR + '="true"] .' + GRID_CLASS +
                '{display:none !important;}' +
            '.' + PANEL_CLASS + '[' + COLLAPSED_ATTR + '="true"] .' + HEADER_CLASS +
                '{margin-bottom:0 !important;}';
        (document.head || document.documentElement).appendChild(style);
    }

    // ── Inline colored segment ────────────────────────────────────────────────
    // Optional leading icon (marked decorative for screen readers), then text.
    // Built with textContent — never innerHTML — so user-controlled strings
    // (assignment/rubric titles) can't inject markup.

    function segment(color, iconClass, text) {
        var span = document.createElement('span');
        if (color) span.style.color = color;
        if (iconClass) {
            var icon = document.createElement('i');
            icon.className = iconClass;
            icon.style.fontSize = '0.72rem';
            icon.setAttribute('aria-hidden', 'true');
            span.appendChild(icon);
            span.appendChild(document.createTextNode(' '));
        }
        if (text) span.appendChild(document.createTextNode(text));
        return span;
    }

    // ── Collapse control ──────────────────────────────────────────────────────

    function setPanelCollapsed(panel, collapsed) {
        panel.setAttribute(COLLAPSED_ATTR, collapsed ? 'true' : 'false');
        var header = panel.querySelector('.' + HEADER_CLASS);
        if (header) header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function togglePanel(panel) {
        setPanelCollapsed(panel, panel.getAttribute(COLLAPSED_ATTR) !== 'true');
    }

    function panels(root) {
        return Array.prototype.slice.call(
            (root || document).querySelectorAll('.' + PANEL_CLASS));
    }

    function setAllCollapsed(collapsed, root) {
        panels(root).forEach(function (p) { setPanelCollapsed(p, collapsed); });
    }

    // ── Panel factory ─────────────────────────────────────────────────────────
    // makePanel(label, opts) builds the bordered, collapsible box with a header
    // and an empty grid, and returns:
    //   { panel, addRow(rowLabel, valueNode) -> valueCell, grid }
    // The caller appends `panel` where it wants and fills rows via addRow.
    // opts.icon overrides the header glyph (default 'icon-analytics').

    function makePanel(label, opts) {
        opts = opts || {};
        ensureStyle();

        var panel = document.createElement('div');
        panel.className = PANEL_CLASS;
        panel.style.cssText =
            'margin-top:8px;padding:10px 13px;' +
            'background:' + COLORS.surface + ';' +
            'border:0.5px solid ' + COLORS.border + ';border-radius:6px;' +
            'font-size:0.78rem;line-height:1.5;';

        // Header — clickable to collapse/expand this panel
        var header = document.createElement('div');
        header.className = HEADER_CLASS;
        header.style.cssText =
            'display:flex;align-items:center;gap:6px;margin-bottom:7px;';
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.setAttribute('aria-expanded', 'true');
        header.title = 'Collapse or expand this panel';

        var caret = document.createElement('i');
        caret.className = 'icon-line icon-arrow-open-down ' + CARET_CLASS;
        caret.style.cssText = 'font-size:0.6rem;color:' + COLORS.header + ';';
        caret.setAttribute('aria-hidden', 'true');
        header.appendChild(caret);

        // Optional type glyph. Omitted by default — the label carries the
        // meaning, and a second icon next to the caret adds noise.
        if (opts.icon) {
            var hIcon = document.createElement('i');
            hIcon.className = 'icon-line ' + opts.icon;
            hIcon.style.cssText = 'font-size:0.72rem;color:' + COLORS.header + ';';
            hIcon.setAttribute('aria-hidden', 'true');
            header.appendChild(hIcon);
        }

        var hText = document.createElement('span');
        hText.textContent = label;
        hText.style.cssText =
            'font-size:0.72rem;font-weight:600;letter-spacing:0.3px;' +
            'color:' + COLORS.header + ';';
        header.appendChild(hText);

        header.addEventListener('click', function () { togglePanel(panel); });
        header.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                togglePanel(panel);
            }
        });

        panel.appendChild(header);

        // Label / value grid — this is what collapses
        var grid = document.createElement('div');
        grid.className = GRID_CLASS;
        grid.style.cssText =
            'display:grid;grid-template-columns:auto 1fr;gap:4px 10px;' +
            'align-items:baseline;';
        panel.appendChild(grid);

        function addRow(rowLabel, valueNode) {
            var labelCell = document.createElement('div');
            labelCell.textContent = rowLabel;
            labelCell.style.cssText =
                'font-weight:600;color:' + COLORS.muted + ';white-space:nowrap;';

            var valueCell = document.createElement('div');
            valueCell.style.color = COLORS.text;
            if (valueNode) valueCell.appendChild(valueNode);

            grid.appendChild(labelCell);
            grid.appendChild(valueCell);
            return valueCell;
        }

        // Full-width content inside the collapsible body, for cases where a
        // label/value pair is the wrong shape (a table, for instance).
        function addBlock(node) {
            if (!node) return null;
            node.style.gridColumn = '1 / -1';
            grid.appendChild(node);
            return node;
        }

        return { panel: panel, addRow: addRow, addBlock: addBlock, grid: grid };
    }

    // ── Table builder ─────────────────────────────────────────────────────────
    // For panels whose rows are homogeneous, where a repeated label column
    // would be redundant. `rows` is an array of cell arrays; each cell may be
    // a DOM node or a plain value. Uses th/scope and an optional caption so
    // screen readers announce it as a real table.

    function makeTable(headings, rows, caption) {
        var table = document.createElement('table');
        table.style.cssText =
            'width:100%;border-collapse:collapse;font-size:inherit;' +
            'text-align:left;';

        if (caption) {
            var cap = document.createElement('caption');
            cap.textContent = caption;
            cap.style.cssText =
                'text-align:left;font-weight:600;color:' + COLORS.muted + ';' +
                'padding:0 0 6px;';
            table.appendChild(cap);
        }

        var thead = document.createElement('thead');
        var headRow = document.createElement('tr');
        headings.forEach(function (heading) {
            var th = document.createElement('th');
            th.setAttribute('scope', 'col');
            th.textContent = heading;
            th.style.cssText =
                'text-align:left;font-weight:600;white-space:nowrap;' +
                'color:' + COLORS.muted + ';padding:0 12px 5px 0;' +
                'border-bottom:1px solid ' + COLORS.border + ';';
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        rows.forEach(function (cells, rowIndex) {
            var tr = document.createElement('tr');
            var isLast = rowIndex === rows.length - 1;
            cells.forEach(function (cell) {
                var td = document.createElement('td');
                td.style.cssText =
                    'padding:5px 12px 5px 0;vertical-align:baseline;' +
                    'color:' + COLORS.text +
                    (isLast ? ';' : ';border-bottom:0.5px solid ' + COLORS.border + ';');
                if (cell && cell.nodeType === 1) {
                    td.appendChild(cell);
                } else if (cell != null && cell !== '') {
                    td.textContent = String(cell);
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        return table;
    }

    // ── Status / control bar style ────────────────────────────────────────────
    // The loading indicator and collapse-all controls sit outside a panel but
    // should read as the same family. Shared here so both features stay in step.

    function barStyle() {
        return 'display:flex;align-items:center;gap:8px;margin:8px 0;' +
               'padding:9px 13px;background:' + COLORS.surface + ';' +
               'border:0.5px solid ' + COLORS.border + ';border-radius:6px;' +
               'font-size:0.8rem;color:' + COLORS.text + ';';
    }

    return {
        COLORS:            COLORS,
        PANEL_CLASS:       PANEL_CLASS,
        SPIN_CLASS:        SPIN_CLASS,
        ensureStyle:       ensureStyle,
        segment:           segment,
        makePanel:         makePanel,
        makeTable:         makeTable,
        barStyle:          barStyle,
        panels:            panels,
        setPanelCollapsed: setPanelCollapsed,
        togglePanel:       togglePanel,
        setAllCollapsed:   setAllCollapsed
    };
})();
