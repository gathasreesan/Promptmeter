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
        primary: token('--color-primary', '#2E7D32'),
        carbon: token('--color-carbon', '#EF6C00'),
        carbonFill: token('--chart-carbon-fill', 'rgba(239, 108, 0, 0.25)'),
        border: token('--border-color', '#DCE8DD'),
        textSecondary: token('--text-secondary', '#55605A'),
        textMuted: token('--text-muted', '#7A857E')
    };
};

const THEME_OPTIONS = [
    { id: 'light', icon: '☀️', label: 'Light' },
    { id: 'dark', icon: '🌙', label: 'Dark' },
    { id: 'auto', icon: '🖥️', label: 'Auto' }
];

const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'queries', label: 'Queries Log' },
    { id: 'insights', label: 'Advisor Insights' }
];

const CHART_RANGES = ['daily', 'weekly', 'monthly'];

// Efficiency thresholds shared by the rating banner, the KPI colouring and the score pills.
const RATINGS = [
    {
        min: 90,
        name: "Optimal Eco-Prompter",
        color: COLOR.primary,
        wash: 'var(--wash-success)',
        washStrong: 'var(--wash-success-strong)',
        description: "Splendid! Your prompting structure avoids greetings and polite fillers, maximizing reasoning tokens while minimizing your carbon footprint."
    },
    {
        min: 70,
        name: "Eco-Conscious Prompter",
        color: COLOR.warning,
        wash: 'var(--wash-warning)',
        washStrong: 'var(--wash-warning-strong)',
        description: "Great start. You can save up to 15% more token computations by avoiding polite phrasing (please, thank you) and eliminating redundant formatting constraints."
    },
    {
        min: 0,
        name: "High Impact Prompter",
        color: COLOR.error,
        wash: 'var(--wash-error)',
        washStrong: 'var(--wash-error-strong)',
        description: "Your prompt queries are carrying redundant weights, greetings, and repetitive phrases. ACCEPT the coach's suggestions to optimize your compute score."
    }
];

// Severities map to CSS classes (.sev-warning / .sev-success / .sev-info) which carry
// the fill, border and pill colour for both themes.
const SEVERITIES = ['warning', 'success', 'info'];

/** Hand-curated dataset shown when there is no real history to display yet. */
const getMockHistory = () => {
    const now = new Date();

    return Array.from({ length: 10 }, (_, index) => {
        const i = 9 - index;
        const date = new Date(now);
        date.setMinutes(now.getMinutes() - (i * 150)); // scatters dates/hours

        const multiplier = (i % 3 === 0) ? 1.4 : (i % 2 === 0) ? 0.9 : 1.1;
        const isOpt = i % 3 === 0;

        return {
            prompt: isOpt
                ? "Write a python script to parse server logs."
                : "Hello ChatGPT, could you please write write a python script to parse log files? thank you!",
            originalPrompt: isOpt
                ? "Hey ChatGPT!! I was just wondering if you could please kindly write write a python script to parse server logs? Thanks a lot in advance!"
                : null,
            response: `Here is a lightweight Python script that parses server logs using regex...`,
            promptTokens: isOpt ? 10 : Math.round(20 * multiplier),
            responseTokens: Math.round(110 * multiplier),
            totalTokens: isOpt ? 120 : Math.round(130 * multiplier),
            electricity: parseFloat((isOpt ? 0.120 : 0.130 * multiplier).toFixed(4)),
            carbon: parseFloat((isOpt ? 0.043 : 0.047 * multiplier).toFixed(4)),
            efficiencyScore: isOpt ? 100 : Math.round(68 + (i * 3.2) % 22),
            wasOptimized: isOpt,
            tokensSaved: isOpt ? 10 : 0,
            carbonSaved: isOpt ? 0.45 : 0,
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

/** Groups history into { labels, carbon, tokens } series for the chart. */
const buildSeries = (history, range) => {
    const groups = new Map();

    history.forEach(item => {
        const label = bucketLabel(new Date(item.timestamp), range);
        const group = groups.get(label) || { carbon: 0, tokens: 0 };
        group.carbon += item.carbon || 0;
        group.tokens += item.totalTokens || 0;
        groups.set(label, group);
    });

    return {
        labels: [...groups.keys()],
        carbon: [...groups.values()].map(g => parseFloat(g.carbon.toFixed(3))),
        tokens: [...groups.values()].map(g => g.tokens)
    };
};

const chartConfig = (series) => {
    const C = readChartTokens();
    const axisTicks = (color) => ({ color: color, font: { family: 'Inter', size: 10 } });

    return {
        type: 'bar',
        data: {
            labels: series.labels,
            datasets: [
                {
                    label: 'Carbon Footprint (g CO₂)',
                    data: series.carbon,
                    backgroundColor: C.carbonFill,
                    borderColor: C.carbon,
                    borderWidth: 1.5,
                    borderRadius: 4,
                    yAxisID: 'y'
                },
                {
                    label: 'Tokens Consumed',
                    data: series.tokens,
                    type: 'line',
                    borderColor: C.primary,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointBackgroundColor: C.primary,
                    tension: 0.15,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: C.textSecondary, font: { family: 'Inter', size: 11, weight: '600' } }
                }
            },
            scales: {
                x: { grid: { color: C.border }, ticks: axisTicks(C.textMuted) },
                y: {
                    type: 'linear', display: true, position: 'left',
                    grid: { color: C.border }, ticks: axisTicks(C.carbon)
                },
                y1: {
                    type: 'linear', display: true, position: 'right',
                    grid: { drawOnChartArea: false }, ticks: axisTicks(C.primary)
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
            {icon && <span style={{ fontSize: 18 }}>{icon}</span>}
            <h3 className="panel-title">{title}</h3>
        </div>
        {children}
    </div>
);

const KpiCard = ({ label, value, unit, accent }) => (
    <div className={`glass-panel kpi-card${accent ? ' kpi-accent' : ''}`}>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value" style={unit ? { color: COLOR.carbon } : undefined}>
            {value}
            {unit && <span className="kpi-unit">{unit}</span>}
        </div>
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
        {!badge.unlocked && <span className="badge-lock">🔒</span>}
        <div className="badge-icon">{badge.icon}</div>
        <span className="badge-name">{badge.name}</span>
        <span className="badge-desc">{badge.description}</span>
    </div>
);

const AttachmentPills = ({ item }) => {
    const pills = [
        { count: item.attachedLinks, icon: '🔗', label: 'URL', color: COLOR.info },
        { count: item.attachedImages, icon: '🖼️', label: 'Img', color: COLOR.primary },
        { count: item.attachedDocs, icon: '📎', label: 'Doc', color: COLOR.carbon }
    ].filter(pill => pill.count > 0);

    if (pills.length === 0) return null;

    return (
        <div className="pill-group">
            {pills.map(pill => (
                <span key={pill.label} className="pill" style={{ '--pill-color': pill.color }}>
                    {pill.icon} {pill.count} {pill.label}
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
                <span className="comparison-title">✂️ What the coach removed</span>
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
    const rating = RATINGS.find(r => item.efficiencyScore >= r.min);
    const scoreColor = item.efficiencyScore >= 90 ? COLOR.success : rating.color;

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
                        {expanded ? '▾' : '▸'} {expanded ? 'Hide' : 'Compare'} original vs optimized
                    </button>
                )}
            </td>
            <td className="cell-numeric">{item.totalTokens.toLocaleString()}</td>
            <td className="cell-numeric" style={{ color: COLOR.carbon }}>{item.carbon.toFixed(2)}g</td>
            <td className="align-center">
                {item.wasOptimized ? (
                    <span className="pill" style={{ '--pill-color': COLOR.primary, fontSize: 11 }}>
                        -{item.carbonSaved.toFixed(2)}g
                    </span>
                ) : (
                    <span style={{ color: COLOR.textMuted }}>-</span>
                )}
            </td>
            <td className="align-right">
                <span
                    className="score-pill"
                    style={{ '--pill-color': scoreColor, '--pill-bg': rating.washStrong }}
                >
                    {item.efficiencyScore}%
                </span>
            </td>
            <td className="align-center">
                <button
                    className="btn-danger-icon"
                    title="Delete query log entry"
                    onClick={() => onDelete(item.timestamp)}
                >
                    🗑️
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
                    <span aria-hidden="true">{option.icon}</span> {option.label}
                </button>
            ))}
        </div>
    </div>
);

// --- Tab panels --------------------------------------------------------------

const OverviewTab = ({ stats, weeklyChallenge, currentStreak, filterMode, setFilterMode, chartRef }) => (
    <div>
        <div className="kpi-grid">
            <KpiCard label="Logged Queries" value={stats.totalQueries} />
            <KpiCard label="Total Tokens" value={stats.totalTokens.toLocaleString()} />
            <KpiCard label="Carbon Footprint" value={stats.totalCarbon.toFixed(1)} unit="g CO₂" />
            <KpiCard label="Avg Efficiency" value={`${stats.avgEfficiency}%`} accent />
        </div>

        <div className="split-main">
            <div className="stack">
                <Panel>
                    <div className="row-between" style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 16 }}>🏆</span>
                            <h3 className="panel-title">{weeklyChallenge.title}</h3>
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: COLOR.primary }}>
                            Saved: {weeklyChallenge.currentValue} / 2.0g target
                        </div>
                    </div>
                    <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${weeklyChallenge.progress}%` }} />
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader title="Environmental Footprint Over Time">
                        <Segmented options={CHART_RANGES} value={filterMode} onChange={setFilterMode} />
                    </PanelHeader>
                    <div style={{ height: 260, position: 'relative' }}>
                        <canvas ref={chartRef} />
                    </div>
                </Panel>
            </div>

            <div className="stack">
                <Panel className="panel-accent" style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🔥</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: COLOR.textSecondary, marginBottom: 4 }}>
                        Coaching Streak
                    </div>
                    <div className="kpi-value" style={{ fontSize: 30, color: COLOR.streak }}>
                        {currentStreak} Days
                    </div>
                </Panel>

                <Panel>
                    <h4 className="section-label">Saved by Coach</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <StatRow label="Tokens Saved" value={stats.totalTokensSaved} color={COLOR.primary} />
                        <StatRow label="Carbon Saved" value={`${stats.totalCarbonSaved.toFixed(1)}g`} color={COLOR.carbon} />
                    </div>
                </Panel>
            </div>
        </div>
    </div>
);

const QueriesTab = ({ rows, hasHistory, searchTerm, setSearchTerm, onClearAll, onDelete }) => (
    <Panel>
        <PanelHeader title="Queries Log">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                    type="text"
                    className="search-input"
                    placeholder="Search queries..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
                {hasHistory && (
                    <button className="btn-danger" onClick={onClearAll}>🗑️ Clear All Logs</button>
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
                        <th className="align-right">Carbon</th>
                        <th className="align-center">Savings</th>
                        <th className="align-right">Score</th>
                        <th className="align-center">Actions</th>
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
                        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
                            AI Sustainability Coach Dashboard
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
                        icon="⚠️"
                        title="Critical Optimization Warnings"
                        items={criticalFixes}
                        emptyMessage="🎉 Excellent work! No warnings detected. Your prompting cycles are carbon efficient."
                    />
                    <RecommendationList
                        icon="💡"
                        title="Efficiency Best Practices"
                        items={bestPractices}
                        emptyMessage="No diagnostics logs available yet. Make more queries to generate tips."
                    />
                </div>

                <div className="stack">
                    <Panel>
                        <div className="panel-header" style={{ marginBottom: 16 }}>
                            <h3 className="panel-title">Eco Milestones</h3>
                        </div>
                        <div className="badge-grid">
                            {badges.map(badge => <BadgeTile key={badge.id} badge={badge} />)}
                        </div>
                    </Panel>

                    <Panel className="panel-accent" style={{ padding: 20 }}>
                        <h4 className="section-label" style={{ fontSize: 11, marginBottom: 12 }}>
                            Coaching Summary
                        </h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                            <StatRow label="Active Streak:" value={`${currentStreak} Days`} />
                            <StatRow
                                label="Eco-Badges Unlocked:"
                                value={`${badges.filter(b => b.unlocked).length} / ${badges.length}`}
                                color={COLOR.primary}
                            />
                        </div>
                    </Panel>
                </div>
            </div>
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
        .filter(item =>
            item.prompt.toLowerCase().includes(query) ||
            item.response.toLowerCase().includes(query) ||
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
                    <span style={{ fontSize: 20 }}>🌿</span>
                    <div>
                        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em' }}>
                            PromptMeter
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, fontSize: 10, fontWeight: 700, color: COLOR.primary }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLOR.primary, display: 'inline-block' }} />
                            COACH ACTIVE
                        </div>
                    </div>
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
                    Version 1.0.0
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
                    />
                )}

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
