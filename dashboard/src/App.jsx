import React, { useState, useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';
import { PromptMeterRecommendations } from '../../utils/recommendations.js';
import { PromptMeterGamification } from '../../utils/gamification.js';
import { PromptMeterStorage } from '../../utils/storage.js';
import { PromptMeterTheme } from '../../utils/theme.js';
import { PromptMeterTokenizer } from '../../utils/tokenizer.js';
import { PromptMeterCalculator } from '../../utils/calculator.js';

// Every colour is a CSS variable, so light and dark are handled entirely by the
// stylesheet and nothing here needs to know which theme is active.
const COLOR = {
    primary: 'var(--color-primary)',
    carbon: 'var(--color-carbon)',
    warning: 'var(--color-warning)',
    error: 'var(--color-error)',
    success: 'var(--color-success)',
    info: 'var(--color-info)',
    streak: 'var(--color-streak)',
    textSecondary: 'var(--text-secondary)',
    textMuted: 'var(--text-muted)'
};

// Chart.js paints to a canvas and cannot resolve CSS variables, so the current
// values are read off the document whenever the chart is built.
const readChartTokens = () => {
    const styles = getComputedStyle(document.documentElement);
    const token = (name, fallback) => (styles.getPropertyValue(name) || fallback).trim();

    return {
        primary: token('--color-primary', '#1c5d20'),
        carbon: token('--color-carbon', '#EF6C00'),
        carbonFill: token('--chart-carbon-fill', 'rgba(239, 108, 0, 0.25)'),
        series1: token('--chart-series-1', '#2a78d6'),
        series2: token('--chart-series-2', '#eb6834'),
        surface: token('--bg-card', '#FFFFFF'),
        // The page's own stack: a bare 'Inter' is never loaded here and fell back to serif.
        font: token('--font-body', 'system-ui, sans-serif'),
        border: token('--border-color', '#E3E8E4'),
        textSecondary: token('--text-secondary', '#5A6470'),
        textMuted: token('--text-muted', '#6E7781')
    };
};

const THEME_OPTIONS = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'auto', label: 'Auto' }
];

/**
 * Inline icon set.
 *
 * Replaces the emoji the UI used to render. Emoji look different on every platform,
 * cannot inherit colour or stroke weight, and sit on the text baseline rather than
 * aligning to the label beside them, so a row of them never quite lines up. These are
 * drawn on a 24-unit grid, inherit currentColor and take their size from a prop.
 */
const ICON_PATHS = {
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
    document: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13M9 7V4h6v3',
    lock: 'M6 11h12v10H6zM9 11V7a3 3 0 0 1 6 0v4',
    warning: 'M12 3 2 20h20zM12 10v5M12 18h.01',
    trophy: 'M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M10 19h4M12 14v5',
    flame: 'M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 1-3s1 2 2 2 1-4 2-8z',
    scissors: 'M6 4l12 12M18 4L6 16M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 6l6 6-6 6',
    check: 'M4 12l5 5L20 6'
};

const Icon = ({ name, size = 16, className = '' }) => {
    const path = ICON_PATHS[name];
    if (!path) return null;

    return (
        <svg
            className={`icon${className ? ' ' + className : ''}`}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path d={path} />
        </svg>
    );
};

const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'queries', label: 'History' },
    { id: 'insights', label: 'Insights' },
    { id: 'settings', label: 'Dictionary & Reports' },
    { id: 'logs', label: 'Logs' }
];

// Colour by level through the existing status tokens; the word is always shown too.
const LEVEL_COLOR = { error: 'var(--color-error)', warn: 'var(--color-warning)', info: 'var(--text-muted)' };

const LogsTab = () => {
    const [entries, setEntries] = useState([]);
    const [onlyProblems, setOnlyProblems] = useState(false);
    const [query, setQuery] = useState('');

    const load = () => PromptMeterStorage.getLog(setEntries);
    useEffect(() => {
        load();
        // Live: the content script flushes every couple of seconds.
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return undefined;
        const onChange = (changes, area) => { if (area === 'local' && changes.eventLog) setEntries(changes.eventLog.newValue || []); };
        chrome.storage.onChanged.addListener(onChange);
        return () => chrome.storage.onChanged.removeListener(onChange);
    }, []);

    const q = query.toLowerCase();
    const shown = entries.slice().reverse()
        .filter(e => !onlyProblems || e.lvl === 'error' || e.lvl === 'warn')
        .filter(e => !q || (e.k + ' ' + e.m + ' ' + JSON.stringify(e.d || {})).toLowerCase().includes(q));
    const problems = entries.filter(e => e.lvl === 'error' || e.lvl === 'warn').length;

    return (
        <Panel>
            <PanelHeader title={`Event log (${entries.length}, ${problems} problems)`}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="search-input" placeholder="Filter…" value={query}
                           onChange={(e) => setQuery(e.target.value)} aria-label="Filter log" />
                    <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
                        Problems only
                    </label>
                    <button className="btn-secondary" disabled={!entries.length}
                            onClick={() => downloadFile(`promptmeter-${today()}.log`, PromptMeterStorage.formatLog(entries))}>
                        Download .log
                    </button>
                    <button className="btn-secondary" disabled={!entries.length}
                            onClick={() => downloadFile(`promptmeter-${today()}.jsonl`, entries.map(e => JSON.stringify(e)).join('\n'))}>
                        .jsonl
                    </button>
                    <button className="btn-danger" disabled={!entries.length} onClick={() => {
                        if (window.confirm('Delete the whole event log?')) PromptMeterStorage.clearLog(load);
                    }}><Icon name="trash" size={14} /> Clear</button>
                </div>
            </PanelHeader>
            <p className="settings-note">
                What PromptMeter did and what went wrong, newest first: suggestions shown, applies, reverts,
                captured turns, skipped error replies, and any failure. Kept on this computer only, the last
                {' '}{PromptMeterStorage.LOG_MAX} entries.
            </p>
            <div className="table-scroll">
                <table className="data-table">
                    <thead><tr><th>Time</th><th>Level</th><th>Event</th><th style={{ width: '55%' }}>Details</th></tr></thead>
                    <tbody>
                        {shown.length === 0
                            ? <tr><td className="cell-empty" colSpan="4">No entries{onlyProblems ? ' with problems' : ''} yet.</td></tr>
                            : shown.slice(0, 300).map((e, i) => (
                                <tr key={e.t + ':' + i}>
                                    <td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(e.t)}</td>
                                    <td style={{ color: LEVEL_COLOR[e.lvl] || LEVEL_COLOR.info, fontWeight: 700, textTransform: 'uppercase', fontSize: 11 }}>{e.lvl}</td>
                                    <td style={{ whiteSpace: 'nowrap' }}>{e.k}</td>
                                    <td>{e.m}{e.d ? <span style={{ color: 'var(--text-muted)' }}> {JSON.stringify(e.d)}</span> : null}</td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </Panel>
    );
};

// Saves text as a file. A Blob URL, so nothing leaves the machine and no download
// permission is needed. The BOM makes Excel read the file as UTF-8.
const downloadFile = (filename, text) => {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const today = () => new Date().toISOString().slice(0, 10);

const HISTORY_COLUMNS = [
    ['timestamp', 'Time'], ['prompt', 'Prompt sent'], ['originalPrompt', 'Prompt before PromptMeter'],
    ['wasOptimized', 'Optimized'], ['promptTokens', 'Prompt tokens'], ['responseTokens', 'Response tokens'],
    ['totalTokens', 'Total tokens'], ['tokensSaved', 'Tokens saved'], ['efficiencyScore', 'Efficiency score'],
    ['carbon', 'CO2 (g)'], ['carbonSaved', 'CO2 saved (g)'], ['response', 'Response']
];

const REPORT_COLUMNS = [
    ['timestamp', 'Time'], ['category', 'Category'], ['finding', 'Finding'], ['word', 'Word'],
    ['prompt', 'Prompt'], ['suggestion', 'Suggestion']
];

const CHART_RANGES = ['daily', 'weekly', 'monthly'];

// Efficiency thresholds shared by the rating banner, the KPI colouring and the score pills.
const RATINGS = [
    {
        min: 90,
        name: "Efficient",
        color: COLOR.primary,
        wash: 'var(--wash-success)',
        washStrong: 'var(--wash-success-strong)',
        description: "Your prompts are direct and carry little filler."
    },
    {
        min: 70,
        name: "Good",
        color: COLOR.warning,
        wash: 'var(--wash-warning)',
        washStrong: 'var(--wash-warning-strong)',
        description: "Some filler remains. Dropping greetings and repeated constraints would save up to 15% more tokens."
    },
    {
        min: 0,
        name: "Needs work",
        color: COLOR.error,
        wash: 'var(--wash-error)',
        washStrong: 'var(--wash-error-strong)',
        description: "Prompts carry greetings, repetition and filler. Applying the suggested rewrites will raise this score."
    }
];

// Severities map to CSS classes (.sev-warning / .sev-success / .sev-info) which carry
// the fill, border and pill colour for both themes.
const SEVERITIES = ['warning', 'success', 'info'];

/**
 * Grams of CO2 at a readable scale. Savings are fractions of a milligram per prompt,
 * so toFixed(1) printed "0.0g" for every real history.
 */
const formatGrams = (grams) => {
    const g = Number(grams) || 0;
    if (g <= 0) return '0 g';
    if (g < 0.001) return '<1 mg';
    if (g < 1) return `${Math.round(g * 1000)} mg`;
    return `${g.toFixed(1)} g`;
};

/** Hand-curated dataset shown when there is no real history to display yet. */
const getMockHistory = () => {
    const now = new Date();

    return Array.from({ length: 10 }, (_, index) => {
        const i = 9 - index;
        const date = new Date(now);
        date.setMinutes(now.getMinutes() - (i * 150)); // scatters dates/hours

        const multiplier = (i % 3 === 0) ? 1.4 : (i % 2 === 0) ? 0.9 : 1.1;
        const isOpt = i % 3 === 0;
        // Derived, not typed: the hand-written figures had 120 total tokens beside
        // 10 + 154 prompt and response, and 0.45 g "saved" for 10 tokens -- 125x the
        // calculator's rate -- so the demo showed more carbon saved than was used.
        const promptTokens = isOpt ? 10 : Math.round(20 * multiplier);
        const responseTokens = Math.round(110 * multiplier);
        const footprint = PromptMeterCalculator.calculate(promptTokens + responseTokens);
        const tokensSaved = isOpt ? 10 : 0;

        return {
            prompt: isOpt
                ? "Write a python script to parse server logs."
                : "Hello ChatGPT, could you please write write a python script to parse log files? thank you!",
            originalPrompt: isOpt
                ? "Hey ChatGPT!! I was just wondering if you could please kindly write write a python script to parse server logs? Thanks a lot in advance!"
                : null,
            response: `Here is a lightweight Python script that parses server logs using regex...`,
            promptTokens: promptTokens,
            responseTokens: responseTokens,
            totalTokens: promptTokens + responseTokens,
            electricity: footprint.electricity,
            carbon: footprint.carbon,
            efficiencyScore: isOpt ? 100 : Math.round(68 + (i * 3.2) % 22),
            wasOptimized: isOpt,
            tokensSaved: tokensSaved,
            carbonSaved: PromptMeterCalculator.savings(tokensSaved).carbon,
            attachedImages: (i === 1 || i === 4) ? 1 : 0,
            attachedDocs: (i === 2 || i === 7) ? 1 : 0,
            attachedLinks: i === 3 ? 1 : 0,
            timestamp: date.toISOString()
        };
    });
};

const timeOfDay = (date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const isSameDay = (a, b) =>
    a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();

/** Formats a timestamp into readable relative blocks. */
const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMins = Math.floor((now - date) / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (isSameDay(date, now)) return `Today at ${timeOfDay(date)}`;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameDay(date, yesterday)) return `Yesterday at ${timeOfDay(date)}`;

    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Bucket label for a timestamp under the selected chart range. */
const bucketLabel = (date, range) => {
    if (range === 'daily') {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    if (range === 'weekly') {
        const startOfWeek = new Date(date);
        startOfWeek.setDate(date.getDate() - date.getDay());
        return "Wk " + startOfWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return date.toLocaleDateString(undefined, { year: '2-digit', month: 'short' });
};

/** Groups history into { labels, sent, saved, carbon } series for the chart. */
const buildSeries = (history, range) => {
    const groups = new Map();

    history.forEach(item => {
        const label = bucketLabel(new Date(item.timestamp), range);
        const group = groups.get(label) || { sent: 0, saved: 0, carbon: 0 };
        group.sent += item.totalTokens || 0;
        group.saved += item.tokensSaved || 0;
        group.carbon += item.carbon || 0;
        groups.set(label, group);
    });

    const values = [...groups.values()];
    return {
        labels: [...groups.keys()],
        sent: values.map(g => g.sent),
        saved: values.map(g => g.saved),
        carbon: values.map(g => g.carbon)
    };
};

/**
 * Tokens sent, with tokens saved stacked on top: the whole bar is what the period
 * would have cost without PromptMeter. One axis. The old chart plotted carbon and
 * tokens on two -- but carbon is tokens times a constant, so it drew one quantity
 * twice at two scales. Carbon moved to the tooltip, where it is a derived figure.
 */
const chartConfig = (series) => {
    const C = readChartTokens();
    const ticks = { color: C.textMuted, font: { family: C.font, size: 10 } };

    return {
        type: 'bar',
        data: {
            labels: series.labels,
            datasets: [
                {
                    label: 'Tokens sent',
                    data: series.sent,
                    backgroundColor: C.series1,
                    // The 2px surface-coloured edge is the gap between stacked fills.
                    borderColor: C.surface,
                    borderWidth: { top: 2 },
                    borderSkipped: 'bottom',
                    maxBarThickness: 40,
                    stack: 'tokens'
                },
                {
                    label: 'Tokens saved',
                    data: series.saved,
                    backgroundColor: C.series2,
                    borderRadius: { topLeft: 4, topRight: 4 },
                    borderSkipped: 'bottom',
                    maxBarThickness: 40,
                    stack: 'tokens'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'start',
                    labels: { color: C.textSecondary, boxWidth: 10, boxHeight: 10, font: { family: C.font, size: 11, weight: '600' } }
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`,
                        footer: (items) => {
                            const i = items[0].dataIndex;
                            return `CO₂ used: ${formatGrams(series.carbon[i])}`;
                        }
                    }
                }
            },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: ticks },
                y: {
                    stacked: true, beginAtZero: true,
                    grid: { color: C.border }, border: { display: false },
                    ticks: Object.assign({ precision: 0 }, ticks)
                }
            }
        }
    };
};

// --- Presentational building blocks -----------------------------------------

const Panel = ({ className = '', style, children }) => (
    <div className={`glass-panel ${className}`.trim()} style={style}>{children}</div>
);

const PanelHeader = ({ icon, title, children }) => (
    <div className={children ? "row-between" : "panel-header"} style={children ? { marginBottom: 20 } : undefined}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {icon && <Icon name={icon} size={16} className="panel-icon" />}
            <h3 className="panel-title">{title}</h3>
        </div>
        {children}
    </div>
);

const KpiCard = ({ label, value, sub, positive }) => (
    <div className="kpi-card">
        <div className="kpi-label">{label}</div>
        <div className={`kpi-value${positive ? ' kpi-positive' : ''}`}>{value}</div>
        {sub && <div className="kpi-sub">{sub}</div>}
    </div>
);

const StatRow = ({ label, value, color }) => (
    <div className="stat-row">
        <span>{label}</span>
        <span style={{ color: color }}>{value}</span>
    </div>
);

const Segmented = ({ options, value, onChange }) => (
    <div className="segmented">
        {options.map(option => (
            <button
                key={option}
                className={value === option ? 'active' : ''}
                onClick={() => onChange(option)}
            >
                {option.charAt(0).toUpperCase() + option.slice(1)}
            </button>
        ))}
    </div>
);

const RecommendationCard = ({ recommendation }) => {
    const severity = SEVERITIES.includes(recommendation.severity) ? recommendation.severity : 'info';

    return (
        <div className={`rec-card sev-${severity}`}>
            <div className="row-between">
                <span className="rec-title">{recommendation.title}</span>
                <span className="pill-savings">{recommendation.savings}</span>
            </div>
            <p>{recommendation.description}</p>
        </div>
    );
};

const RecommendationList = ({ icon, title, items, emptyMessage }) => (
    <Panel style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PanelHeader icon={icon} title={title} />
        {items.length === 0 ? (
            <div className="panel-empty">{emptyMessage}</div>
        ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {items.map(item => <RecommendationCard key={item.id} recommendation={item} />)}
            </div>
        )}
    </Panel>
);

const BadgeTile = ({ badge }) => (
    <div className={`badge-tile${badge.unlocked ? '' : ' locked'}`}>
        {!badge.unlocked && <span className="badge-lock"><Icon name="lock" size={14} /></span>}
        <div className="badge-icon"><Icon name={badge.icon} size={20} /></div>
        <span className="badge-name">{badge.name}</span>
        <span className="badge-desc">{badge.description}</span>
    </div>
);

const AttachmentPills = ({ item }) => {
    const pills = [
        { count: item.attachedLinks, icon: 'link', label: 'URL', color: COLOR.info },
        { count: item.attachedImages, icon: 'image', label: 'Img', color: COLOR.primary },
        { count: item.attachedDocs, icon: 'document', label: 'Doc', color: COLOR.carbon }
    ].filter(pill => pill.count > 0);

    if (pills.length === 0) return null;

    return (
        <div className="pill-group">
            {pills.map(pill => (
                <span key={pill.label} className="pill" style={{ '--pill-color': pill.color }}>
                    <Icon name={pill.icon} size={13} /> {pill.count} {pill.label}
                </span>
            ))}
        </div>
    );
};

// What the optimizer actually changed, for one turn. Only rendered when the original
// text was recorded -- turns logged before that was stored, and turns the user never
// optimized, have nothing to compare against.
const ComparisonBox = ({ item }) => {
    const before = PromptMeterTokenizer.countTokens(item.originalPrompt);
    const after = PromptMeterTokenizer.countTokens(item.prompt);
    const saved = Math.max(0, before - after);
    const percent = before > 0 ? Math.round((saved / before) * 100) : 0;

    // Recomputed rather than read off the record, so the figure always matches the two
    // texts shown directly above it.
    const carbonSaved = PromptMeterCalculator.savings(saved).carbon;

    return (
        <div className="comparison-box">
            <div className="comparison-head">
                <span className="comparison-title">Removed by the optimizer</span>
                <span className="comparison-headline">
                    {before} → {after} tokens
                    <em>{percent}% shorter</em>
                </span>
            </div>

            <div className="comparison-panes">
                <div className="comparison-pane comparison-before">
                    <span className="comparison-label">Original</span>
                    <p>{item.originalPrompt}</p>
                </div>
                <div className="comparison-pane comparison-after">
                    <span className="comparison-label">Optimized</span>
                    <p>{item.prompt}</p>
                </div>
            </div>

            <div className="comparison-metrics">
                <div className="comparison-metric">
                    <span className="comparison-metric-value">{before}</span>
                    <span className="comparison-metric-label">Tokens before</span>
                </div>
                <div className="comparison-metric">
                    <span className="comparison-metric-value">{after}</span>
                    <span className="comparison-metric-label">Tokens after</span>
                </div>
                <div className="comparison-metric is-saved">
                    <span className="comparison-metric-value">−{saved}</span>
                    <span className="comparison-metric-label">Tokens saved</span>
                </div>
                <div className="comparison-metric is-saved">
                    <span className="comparison-metric-value">−{carbonSaved.toFixed(3)}g</span>
                    <span className="comparison-metric-label">CO₂ avoided</span>
                </div>
                <div className="comparison-metric is-saved">
                    <span className="comparison-metric-value">{percent}%</span>
                    <span className="comparison-metric-label">Reduction</span>
                </div>
            </div>
        </div>
    );
};

const QueryRow = ({ item, onDelete }) => {
    // RATINGS.find returns undefined for a turn with no score, and reading
    // .color off it threw, taking the whole history list down with it. An
    // unscored turn is shown at the bottom band rather than crashing the tab.
    const score = typeof item.efficiencyScore === 'number' ? item.efficiencyScore : null;
    const rating = (score !== null && RATINGS.find(r => score >= r.min))
        || RATINGS[RATINGS.length - 1];
    const scoreColor = score !== null && score >= 90 ? 'var(--text-primary)' : rating.color;

    const [expanded, setExpanded] = useState(false);
    const hasComparison = Boolean(item.originalPrompt && item.originalPrompt !== item.prompt);

    return (
        <React.Fragment>
        <tr className={expanded ? 'row-expanded' : ''}>
            <td className="cell-muted">{formatTimestamp(item.timestamp)}</td>
            <td className="cell-prompt" style={{ width: '50%' }}>
                <div>{item.prompt.length > 100 ? item.prompt.substring(0, 100) + '...' : item.prompt}</div>
                <AttachmentPills item={item} />
                {hasComparison && (
                    <button
                        className="comparison-toggle"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(!expanded)}
                    >
                        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} /> {expanded ? 'Hide' : 'Show'} original
                    </button>
                )}
            </td>
            <td className="cell-numeric">{item.totalTokens.toLocaleString()}</td>
            <td className="cell-numeric cell-muted">{formatGrams(item.carbon)}</td>
            <td className="align-center">
                {item.wasOptimized && item.tokensSaved > 0 ? (
                    <span className="cell-saved">−{item.tokensSaved}</span>
                ) : (
                    <span style={{ color: COLOR.textMuted }}>–</span>
                )}
            </td>
            <td className="align-right">
                <span
                    className="score-pill"
                    style={{ '--pill-color': scoreColor, '--pill-bg': rating.washStrong }}
                >
                    {score === null ? '--' : score + '%'}
                </span>
            </td>
            <td className="align-center">
                <button
                    className="btn-danger-icon"
                    title="Delete query log entry"
                    onClick={() => onDelete(item.timestamp)}
                >
                    <Icon name="trash" size={15} />
                </button>
            </td>
        </tr>

        {hasComparison && expanded && (
            <tr className="comparison-row">
                <td colSpan="7"><ComparisonBox item={item} /></td>
            </tr>
        )}
        </React.Fragment>
    );
};

const ThemeSwitch = ({ value, onChange }) => (
    <div>
        <div className="theme-switch-label">Appearance</div>
        <div className="theme-switch" role="group" aria-label="Colour theme">
            {THEME_OPTIONS.map(option => (
                <button
                    key={option.id}
                    className={value === option.id ? 'active' : ''}
                    onClick={() => onChange(option.id)}
                    title={`${option.label} theme`}
                    aria-pressed={value === option.id}
                >
                    {option.label}
                </button>
            ))}
        </div>
    </div>
);

// --- Tab panels --------------------------------------------------------------

const OverviewTab = ({ stats, weeklyChallenge, currentStreak, filterMode, setFilterMode, chartRef }) => (
    <div>
        <div className="kpi-grid glass-panel">
            <KpiCard label="Prompts" value={stats.totalQueries.toLocaleString()} />
            <KpiCard label="Tokens sent" value={stats.totalTokens.toLocaleString()}
                     sub={`${formatGrams(stats.totalCarbon)} CO₂`} />
            <KpiCard label="Tokens saved" value={stats.totalTokensSaved.toLocaleString()} positive
                     sub={`${formatGrams(stats.totalCarbonSaved)} CO₂ avoided`} />
            <KpiCard label="Avg efficiency" value={`${stats.avgEfficiency}%`} />
        </div>

        <div className="split-main">
            <div className="stack">
                <Panel>
                    <PanelHeader title="Tokens over time">
                        <Segmented options={CHART_RANGES} value={filterMode} onChange={setFilterMode} />
                    </PanelHeader>
                    <div style={{ height: 260, position: 'relative' }}>
                        <canvas ref={chartRef} />
                    </div>
                </Panel>
            </div>

            <div className="stack">
                <Panel>
                    <h3 className="panel-title" style={{ marginBottom: 16 }}>This week</h3>
                    <div className="goal-line">
                        <span>Weekly goal</span>
                        <span>{weeklyChallenge.currentValue} of {weeklyChallenge.targetLabel}</span>
                    </div>
                    <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${weeklyChallenge.progress}%` }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
                        <StatRow label="Streak" value={`${currentStreak} ${currentStreak === 1 ? 'day' : 'days'}`} />
                        <StatRow label="Tokens saved" value={stats.totalTokensSaved.toLocaleString()} />
                        <StatRow label="CO₂ avoided" value={formatGrams(stats.totalCarbonSaved)} />
                    </div>
                </Panel>
            </div>
        </div>
    </div>
);

const QueriesTab = ({ rows, hasHistory, searchTerm, setSearchTerm, onClearAll, onDelete, onExport, isMockData }) => (
    <Panel>
        <PanelHeader title="History">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                    type="text"
                    className="search-input"
                    placeholder="Search prompts"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
                {/* Disabled on the sample data: exporting the demo would look like the user's history. */}
                <button className="btn-secondary" onClick={onExport} disabled={!hasHistory || isMockData}
                        title={isMockData ? 'This is sample data; nothing of yours to export yet' : 'Download the rows shown as CSV'}>
                    Export CSV
                </button>
                {hasHistory && (
                    <button className="btn-danger" onClick={onClearAll}>Clear history</button>
                )}
            </div>
        </PanelHeader>

        <div className="table-scroll">
            <table className="data-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th style={{ width: '50%' }}>Prompt</th>
                        <th className="align-right">Tokens</th>
                        <th className="align-right">CO₂</th>
                        <th className="align-center">Saved</th>
                        <th className="align-right">Score</th>
                        <th className="align-center"><span className="sr-only">Delete</span></th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 ? (
                        <tr><td className="cell-empty" colSpan="7">No matching records found.</td></tr>
                    ) : (
                        rows.map(item => (
                            <QueryRow key={item.timestamp} item={item} onDelete={onDelete} />
                        ))
                    )}
                </tbody>
            </table>
        </div>
    </Panel>
);

const InsightsTab = ({ avgEfficiency, rating, recommendations, badges, currentStreak }) => {
    const criticalFixes = recommendations.filter(r => r.severity === 'warning');
    const bestPractices = recommendations.filter(r => r.severity !== 'warning');
    const ratingVars = { '--rating-color': rating.color, '--rating-wash': rating.wash };

    return (
        <div className="stack-lg">
            <Panel className="rating-banner" style={ratingVars}>
                <div className="rating-gauge">
                    <span className="rating-gauge-value">{avgEfficiency}%</span>
                    <span className="rating-gauge-label">Health</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>
                            Prompt health
                        </h2>
                        <span className="rating-tag">{rating.name}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, maxWidth: 780, color: COLOR.textSecondary }}>
                        {rating.description}
                    </p>
                </div>
            </Panel>

            <div className="split-wide">
                <div className="stack">
                    <RecommendationList
                        icon="warning"
                        title="Warnings"
                        items={criticalFixes}
                        emptyMessage="No warnings. Your prompts are running efficiently."
                    />
                    <RecommendationList
                        icon="check"
                        title="Suggestions"
                        items={bestPractices}
                        emptyMessage="Nothing yet. Suggestions appear after a few prompts."
                    />
                </div>

                <div className="stack">
                    <Panel>
                        <div className="panel-header" style={{ marginBottom: 16 }}>
                            <h3 className="panel-title">Milestones</h3>
                        </div>
                        <div className="badge-grid">
                            {badges.map(badge => <BadgeTile key={badge.id} badge={badge} />)}
                        </div>
                    </Panel>

                    <Panel>
                        <h3 className="panel-title" style={{ marginBottom: 14 }}>Summary</h3>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <StatRow label="Streak" value={`${currentStreak} ${currentStreak === 1 ? 'day' : 'days'}`} />
                            <StatRow label="Milestones" value={`${badges.filter(b => b.unlocked).length} of ${badges.length}`} />
                        </div>
                    </Panel>
                </div>
            </div>
        </div>
    );
};

const SettingsTab = () => {
    const [dictionary, setDictionary] = useState([]);
    const [reports, setReports] = useState([]);
    const [draft, setDraft] = useState('');

    const load = () => PromptMeterStorage.getSettings({ dictionary: [], fixReports: [] }, (res) => {
        setDictionary(res.dictionary || []);
        setReports(res.fixReports || []);
    });
    useEffect(load, []);

    const addWord = (event) => {
        event.preventDefault();
        if (!draft.trim()) return;
        PromptMeterStorage.addToDictionary(draft, setDictionary);
        setDraft('');
    };

    return (
        <div className="stack">
            <Panel>
                <PanelHeader title="Personal dictionary" />
                <p className="settings-note">
                    Words PromptMeter will never spell-correct: names, product terms, your own jargon.
                    Add them here or with <b>Always keep</b> under a correction's <b>Why?</b>.
                </p>
                <form onSubmit={addWord} style={{ display: 'flex', gap: 10 }}>
                    <input className="search-input" placeholder="Add a word, e.g. Kubernetes"
                           value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Word to add" />
                    <button className="btn-secondary" type="submit" disabled={!draft.trim()}>Add</button>
                </form>
                <div className="word-chips">
                    {dictionary.length === 0
                        ? <span className="settings-note">No words yet.</span>
                        : dictionary.map(word => (
                            <span className="word-chip" key={word}>
                                {word}
                                <button aria-label={`Remove ${word}`} title="Remove"
                                        onClick={() => PromptMeterStorage.removeFromDictionary(word, setDictionary)}>×</button>
                            </span>
                        ))}
                </div>
            </Panel>

            <Panel>
                <PanelHeader title={`Reported fixes (${reports.length})`}>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button className="btn-secondary" disabled={!reports.length}
                                onClick={() => downloadFile(`promptmeter-reports-${today()}.csv`,
                                    PromptMeterStorage.toCSV(reports, REPORT_COLUMNS))}>
                            Export CSV
                        </button>
                        <button className="btn-danger" disabled={!reports.length} onClick={() => {
                            if (!window.confirm('Delete every reported fix?')) return;
                            PromptMeterStorage.clearFixReports(load);
                        }}><Icon name="trash" size={14} /> Clear</button>
                    </div>
                </PanelHeader>
                <p className="settings-note">
                    Corrections you marked as wrong with <b>Report this as wrong</b>. They stay on this
                    computer; the export is how they become training data for the next model.
                </p>
                <div className="table-scroll">
                    <table className="data-table">
                        <thead>
                            <tr><th>When</th><th>Finding</th><th style={{ width: '45%' }}>Prompt</th></tr>
                        </thead>
                        <tbody>
                            {reports.length === 0
                                ? <tr><td className="cell-empty" colSpan="3">Nothing reported yet.</td></tr>
                                : reports.slice().reverse().slice(0, 50).map(r => (
                                    <tr key={r.timestamp + r.finding}>
                                        <td>{formatTimestamp(r.timestamp)}</td>
                                        <td>{r.finding}</td>
                                        <td>{r.prompt}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            </Panel>
        </div>
    );
};

// --- Root --------------------------------------------------------------------

export default function App() {
    const [history, setHistory] = useState([]);
    const [filterMode, setFilterMode] = useState('daily');
    const [searchTerm, setSearchTerm] = useState('');
    const [isMockData, setIsMockData] = useState(false);
    const [activeTab, setActiveTab] = useState(() => localStorage.getItem('promptmeter_active_tab') || 'overview');
    const [theme, setTheme] = useState(() => PromptMeterTheme.readSync());
    const [systemTheme, setSystemTheme] = useState(() => PromptMeterTheme.resolve('auto'));
    const chartRef = useRef(null);
    const chartInstance = useRef(null);

    const handleTabChange = (tabName) => {
        setActiveTab(tabName);
        localStorage.setItem('promptmeter_active_tab', tabName);
    };

    // Apply the stored theme and stay in step with changes made from the popup
    useEffect(() => {
        PromptMeterTheme.start(setTheme);
    }, []);

    const handleThemeChange = (mode) => {
        setTheme(mode);
        PromptMeterTheme.apply(mode);
        PromptMeterTheme.write(mode);
    };

    // Redraw the chart when the effective theme changes, since Chart.js baked the
    // old palette into the canvas.
    useEffect(() => {
        if (theme !== 'auto' || typeof window.matchMedia !== 'function') return;

        const query = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => setSystemTheme(PromptMeterTheme.resolve('auto'));
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, [theme]);

    // Load stored turns, falling back to the sample dataset when there are none
    useEffect(() => {
        PromptMeterStorage.getHistory((logs) => {
            setHistory(logs.length > 0 ? logs : getMockHistory());
            setIsMockData(logs.length === 0);
        });
    }, []);

    const stats = PromptMeterStorage.aggregate(history);
    const avgEfficiency = history.length > 0 ? stats.avgEfficiency : 100;
    const rating = RATINGS.find(r => avgEfficiency >= r.min);

    const currentStreak = PromptMeterGamification.calculateStreak(history);
    const badges = PromptMeterGamification.checkBadges(history);
    const weeklyChallenge = PromptMeterGamification.getWeeklyChallenge(history);
    const recommendations = PromptMeterRecommendations.generate(history);

    // Chart.js render engine
    useEffect(() => {
        if (history.length === 0 || !chartRef.current || activeTab !== 'overview') return;

        if (chartInstance.current) chartInstance.current.destroy();
        chartInstance.current = new Chart(
            chartRef.current.getContext('2d'),
            chartConfig(buildSeries(history, filterMode))
        );

        return () => {
            if (chartInstance.current) chartInstance.current.destroy();
        };
    }, [history, filterMode, activeTab, theme, systemTheme]);

    const query = searchTerm.toLowerCase();
    const visibleRows = history
        // The original text is searched too, so a phrase the coach removed still finds
        // the turn it was removed from.
        // `|| ''` on every field: one stored turn missing its response used to throw
        // here and blank the whole Queries tab.
        .filter(item =>
            (item.prompt || '').toLowerCase().includes(query) ||
            (item.response || '').toLowerCase().includes(query) ||
            (item.originalPrompt || '').toLowerCase().includes(query))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // The sample dataset lives only in component state, so it is never written back to storage
    const persist = (updated) => {
        setHistory(updated);
        if (!isMockData) PromptMeterStorage.setHistory(updated);
    };

    const handleClearHistory = () => {
        if (!window.confirm("Are you sure you want to delete all queries in your log? This action cannot be undone.")) return;
        persist([]);
        setIsMockData(false);
    };

    const handleDeleteTurn = (timestamp) => {
        if (!window.confirm("Are you sure you want to delete this query log entry?")) return;
        persist(history.filter(item => item.timestamp !== timestamp));
    };

    return (
        <div className="app-shell">
            <div className="sidebar">
                <div className="sidebar-brand">
                    <img src="../icons/icon32.png" alt="" width="24" height="24" className="brand-mark" />
                    <div className="brand-name">PromptMeter</div>
                </div>

                <div className="sidebar-nav">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            className={`nav-btn${activeTab === tab.id ? ' active' : ''}`}
                            onClick={() => handleTabChange(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="sidebar-footer">
                    <ThemeSwitch value={theme} onChange={handleThemeChange} />
                    <div className="version">Version 1.0</div>
                </div>
            </div>

            <div className="workspace">
                {activeTab === 'overview' && (
                    <OverviewTab
                        stats={{ ...stats, avgEfficiency }}
                        weeklyChallenge={weeklyChallenge}
                        currentStreak={currentStreak}
                        filterMode={filterMode}
                        setFilterMode={setFilterMode}
                        chartRef={chartRef}
                    />
                )}

                {activeTab === 'queries' && (
                    <QueriesTab
                        rows={visibleRows}
                        hasHistory={history.length > 0}
                        searchTerm={searchTerm}
                        setSearchTerm={setSearchTerm}
                        onClearAll={handleClearHistory}
                        onDelete={handleDeleteTurn}
                        isMockData={isMockData}
                        onExport={() => downloadFile(`promptmeter-history-${today()}.csv`,
                            PromptMeterStorage.toCSV(visibleRows, HISTORY_COLUMNS))}
                    />
                )}

                {activeTab === 'settings' && <SettingsTab />}

                {activeTab === 'logs' && <LogsTab />}

                {activeTab === 'insights' && (
                    <InsightsTab
                        avgEfficiency={avgEfficiency}
                        rating={rating}
                        recommendations={recommendations}
                        badges={badges}
                        currentStreak={currentStreak}
                    />
                )}
            </div>
        </div>
    );
}
