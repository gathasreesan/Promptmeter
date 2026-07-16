import React, { useState, useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';
import { PromptMeterRecommendations } from '../../utils/recommendations.js';
import { PromptMeterGamification } from '../../utils/gamification.js';

// Heuristic mock data helper for local development/preview testing
const getMockHistory = () => {
    const mock = [];
    const now = new Date();
    // Generate mock logs for the last 10 days
    for (let i = 9; i >= 0; i--) {
        const date = new Date(now);
        // Distribute timestamps over days and hours to test formatting variations
        date.setMinutes(now.getMinutes() - (i * 180)); // scatters over hours/days
        const multiplier = (i % 3 === 0) ? 1.5 : (i % 2 === 0) ? 0.8 : 1.1;
        const isOpt = i % 3 === 0; // Mark some turns as optimized by coach
        const hasImg = i === 1 || i === 4;
        const hasDoc = i === 2 || i === 7;
        const hasLink = i === 3;

        mock.push({
            prompt: isOpt 
                ? "Write a python script to parse logs." 
                : "Hello ChatGPT, could you please write write a python script to parse log files? thank you!",
            response: `Here is a lightweight Python script that parses logs using regular expressions...`,
            promptTokens: isOpt ? 9 : Math.round(18 * multiplier),
            responseTokens: Math.round(120 * multiplier),
            totalTokens: isOpt ? 129 : Math.round(138 * multiplier),
            electricity: parseFloat((isOpt ? 0.129 : 0.138 * multiplier).toFixed(4)),
            carbon: parseFloat((isOpt ? 0.046 : 0.049 * multiplier).toFixed(4)),
            water: parseFloat((isOpt ? 0.193 : 0.207 * multiplier).toFixed(4)),
            efficiencyScore: isOpt ? 100 : Math.round(65 + (i * 3) % 25), // Mock inefficient prompt scores
            wasOptimized: isOpt,
            tokensSaved: isOpt ? 9 : 0,
            carbonSaved: isOpt ? 0.45 : 0, // Mock carbon saved per turn
            attachedImages: hasImg ? 1 : 0,
            attachedDocs: hasDoc ? 1 : 0,
            attachedLinks: hasLink ? 1 : 0,
            timestamp: date.toISOString()
        });
    }
    return mock;
};

// Formats timestamp into highly readable relative blocks (Module 13)
const formatTimestamp = (isoString) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (60 * 1000));
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
    
    // Relative time for very recent items (under 1 hour)
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24 && date.getDate() === now.getDate()) {
        return `Today at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }
    
    // Yesterday check
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear()) {
        return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }

    // Standard locale date for older items
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function App() {
    const [history, setHistory] = useState([]);
    const [filterMode, setFilterMode] = useState('daily'); // 'daily' | 'weekly' | 'monthly'
    const [searchTerm, setSearchTerm] = useState('');
    const [isMockData, setIsMockData] = useState(false);
    const chartRef = useRef(null);
    const chartInstance = useRef(null);

    // Load data from Chrome Local Storage or load mocks if running standalone
    useEffect(() => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get({ history: [] }, (result) => {
                const logs = result.history || [];
                if (logs.length === 0) {
                    setHistory(getMockHistory());
                    setIsMockData(true);
                } else {
                    setHistory(logs);
                    setIsMockData(false);
                }
            });
        } else {
            setHistory(getMockHistory());
            setIsMockData(true);
        }
    }, []);

    // Calculate aggregate totals
    const totalQueries = history.length;
    const totalTokens = history.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
    const totalElectricity = history.reduce((sum, item) => sum + (item.electricity || 0), 0);
    const totalCarbon = history.reduce((sum, item) => sum + (item.carbon || 0), 0);
    const totalWater = history.reduce((sum, item) => sum + (item.water || 0), 0);
    const avgEfficiency = totalQueries > 0 
        ? Math.round(history.reduce((sum, item) => sum + (item.efficiencyScore || 100), 0) / totalQueries)
        : 100;

    // Gamification totals (Module 12)
    const totalTokensSaved = history.reduce((sum, item) => sum + (item.tokensSaved || 0), 0);
    const totalCarbonSaved = history.reduce((sum, item) => sum + (item.carbonSaved || 0), 0);
    const currentStreak = PromptMeterGamification.calculateStreak(history);
    const badges = PromptMeterGamification.checkBadges(history);
    const weeklyChallenge = PromptMeterGamification.getWeeklyChallenge(history);

    // Environmental equivalents (educational details)
    const ledHours = (totalElectricity / 10).toFixed(1); // 10W LED bulb
    const drivingMeters = (totalCarbon * 8.3).toFixed(1); // Standard car (120g CO2 per km)
    const waterSips = (totalWater / 10).toFixed(0); // 10mL average sip

    // Generate sustainability and coaching recommendations dynamically (Module 11)
    const recommendations = PromptMeterRecommendations.generate(history);

    // Chart aggregation and creation
    useEffect(() => {
        if (history.length === 0 || !chartRef.current) return;

        const groups = {};
        history.forEach(item => {
            const date = new Date(item.timestamp);
            let label = "";

            if (filterMode === 'daily') {
                label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            } else if (filterMode === 'weekly') {
                const startOfWeek = new Date(date);
                startOfWeek.setDate(date.getDate() - date.getDay());
                label = "Wk " + startOfWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            } else {
                label = date.toLocaleDateString(undefined, { year: '2-digit', month: 'short' });
            }

            if (!groups[label]) {
                groups[label] = { carbon: 0, tokens: 0 };
            }
            groups[label].carbon += item.carbon || 0;
            groups[label].tokens += item.totalTokens || 0;
        });

        const labels = Object.keys(groups);
        const carbonData = Object.values(groups).map(g => parseFloat(g.carbon.toFixed(3)));
        const tokenData = Object.values(groups).map(g => g.tokens);

        // Destroy existing chart to avoid overlay warnings on canvas reuse
        if (chartInstance.current) {
            chartInstance.current.destroy();
        }

        const ctx = chartRef.current.getContext('2d');
        chartInstance.current = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Carbon Footprint (g CO₂)',
                        data: carbonData,
                        backgroundColor: 'rgba(16, 185, 129, 0.65)',
                        borderColor: '#10b981',
                        borderWidth: 1,
                        borderRadius: 6,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Tokens Consumed',
                        data: tokenData,
                        type: 'line',
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.15)',
                        borderWidth: 2,
                        tension: 0.3,
                        fill: true,
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
                        labels: { color: '#9ca3af', font: { family: 'Inter' } }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#9ca3af' }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#10b981' },
                        title: { display: true, text: 'Carbon (g CO₂)', color: '#10b981' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#3b82f6' },
                        title: { display: true, text: 'Tokens', color: '#3b82f6' }
                    }
                }
            }
        });

        return () => {
            if (chartInstance.current) {
                chartInstance.current.destroy();
            }
        };
    }, [history, filterMode]);

    // Filter queries based on search term
    const filteredHistory = history.filter(item => 
        item.prompt.toLowerCase().includes(searchTerm.toLowerCase()) || 
        item.response.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Sort queries in reverse chronological order (newest log on top - Module 13)
    const sortedHistory = [...filteredHistory].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return (
        <div style={{ padding: '28px', maxWidth: '1200px', margin: '0 auto' }}>
            {/* Header Area */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
                <div>
                    <h1 style={{ margin: '0 0 6px 0', fontSize: '28px', fontWeight: '800', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '10px', letterSpacing: '-0.02em' }}>
                        🌿 PromptMeter Coach
                    </h1>
                    <p style={{ margin: 0, color: '#9ca3af', fontSize: '14px', fontWeight: '400' }}>
                        Real-time AI carbon accounting, prompt diagnostics, and eco gamification
                    </p>
                </div>
                
                {isMockData && (
                    <span style={{ background: 'rgba(59, 130, 246, 0.12)', color: '#60a5fa', padding: '6px 16px', borderRadius: '20px', border: '1px solid rgba(59, 130, 246, 0.25)', fontSize: '12px', fontWeight: '600' }}>
                        💡 View Demo Mode (No real extension records found yet)
                    </span>
                )}
            </div>

            {/* KPI Metrics Dashboard Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '28px' }}>
                <div className="glass-panel kpi-card" style={{ padding: '20px', borderRadius: '12px' }}>
                    <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontWeight: '600' }}>Total Queries</div>
                    <div style={{ fontSize: '32px', fontWeight: '800', color: '#ffffff' }}>{totalQueries}</div>
                    <div style={{ fontSize: '11px', color: '#34d399', marginTop: '6px', fontWeight: '500' }}>Logged turns</div>
                </div>

                <div className="glass-panel kpi-card" style={{ padding: '20px', borderRadius: '12px' }}>
                    <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontWeight: '600' }}>Tokens Estimated</div>
                    <div style={{ fontSize: '32px', fontWeight: '800', color: '#3b82f6' }}>{totalTokens.toLocaleString()}</div>
                    <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '6px', fontWeight: '500' }}>Processed via tiktoken</div>
                </div>

                <div className="glass-panel kpi-card" style={{ padding: '20px', borderRadius: '12px' }}>
                    <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontWeight: '600' }}>Carbon Footprint</div>
                    <div style={{ fontSize: '32px', fontWeight: '800', color: '#10b981' }}>{totalCarbon.toFixed(2)}<span style={{ fontSize: '16px', fontWeight: '500', color: '#9ca3af', marginLeft: '2px' }}>g CO₂</span></div>
                    <div style={{ fontSize: '11px', color: '#34d399', marginTop: '6px', fontWeight: '500' }}>🚗 Drive {drivingMeters}m</div>
                </div>

                <div className="glass-panel kpi-card" style={{ padding: '20px', borderRadius: '12px' }}>
                    <div style={{ fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontWeight: '600' }}>Water Cooling</div>
                    <div style={{ fontSize: '32px', fontWeight: '800', color: '#38bdf8' }}>{totalWater.toFixed(1)}<span style={{ fontSize: '16px', fontWeight: '500', color: '#9ca3af', marginLeft: '2px' }}>mL</span></div>
                    <div style={{ fontSize: '11px', color: '#38bdf8', marginTop: '6px', fontWeight: '500' }}>🥤 {waterSips} sips equivalent</div>
                </div>

                <div className="glass-panel kpi-card glow-green" style={{ padding: '20px', borderRadius: '12px' }}>
                    <div style={{ fontSize: '11px', color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px', fontWeight: '600' }}>Avg Efficiency</div>
                    <div style={{ fontSize: '32px', fontWeight: '800', color: '#10b981' }}>{avgEfficiency}%</div>
                    <div style={{ fontSize: '11px', color: '#a7f3d0', marginTop: '6px', fontWeight: '500' }}>Coach Goal: &gt;90%</div>
                </div>
            </div>

            {/* Split Screen Grid Layout */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '24px', alignItems: 'start', marginBottom: '28px' }}>
                
                {/* Left Column: Metrics & Analytics */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    
                    {/* Weekly Carbon Challenge Panel */}
                    <div className="glass-panel" style={{ padding: '20px 24px', borderRadius: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontSize: '20px' }}>⚡</span>
                                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '700', color: '#ffffff', letterSpacing: '-0.01em' }}>
                                    {weeklyChallenge.title}
                                </h3>
                            </div>
                            <div style={{ fontSize: '13px', color: '#10b981', fontWeight: '700' }}>
                                Saved: {weeklyChallenge.currentValue} / Goal: 2.00g
                            </div>
                        </div>

                        {/* Progress Bar container */}
                        <div style={{ width: '100%', height: '10px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '10px', overflow: 'hidden', position: 'relative', marginBottom: '8px' }}>
                            <div style={{ width: `${weeklyChallenge.progress}%`, height: '100%', background: '#10b981', borderRadius: '10px', transition: 'width 0.5s ease', boxShadow: '0 0 10px #10b981' }}></div>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#9ca3af' }}>
                            <span>Challenge progress: {weeklyChallenge.progress}%</span>
                            <span style={{ fontWeight: '600', color: weeklyChallenge.completed ? '#34d399' : '#9ca3af' }}>
                                {weeklyChallenge.completed ? "🎉 Challenge Completed! Keep it up!" : "In progress..."}
                            </span>
                        </div>
                    </div>

                    {/* Graphs and Charts Block */}
                    <div className="glass-panel" style={{ padding: '24px', borderRadius: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#ffffff', letterSpacing: '-0.01em' }}>Environmental Impact Trends</h3>
                            
                            <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden' }}>
                                <button className={`nav-btn ${filterMode === 'daily' ? 'active' : ''}`} style={{ padding: '6px 16px', fontSize: '12px', borderRight: 'none' }} onClick={() => setFilterMode('daily')}>Daily</button>
                                <button className={`nav-btn ${filterMode === 'weekly' ? 'active' : ''}`} style={{ padding: '6px 16px', fontSize: '12px', borderRight: 'none' }} onClick={() => setFilterMode('weekly')}>Weekly</button>
                                <button className={`nav-btn ${filterMode === 'monthly' ? 'active' : ''}`} style={{ padding: '6px 16px', fontSize: '12px' }} onClick={() => setFilterMode('monthly')}>Monthly</button>
                            </div>
                        </div>

                        <div style={{ height: '320px', position: 'relative' }}>
                            <canvas ref={chartRef}></canvas>
                        </div>
                    </div>

                    {/* Coach Recommendations Panel */}
                    <div className="glass-panel" style={{ padding: '24px', borderRadius: '12px' }}>
                        <h3 style={{ margin: '0 0 18px 0', fontSize: '16px', fontWeight: '700', color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '-0.01em' }}>
                            💡 AI Coach Sustainability Recommendations
                        </h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                            {recommendations.map((rec) => {
                                let borderCol = 'rgba(255, 255, 255, 0.08)';
                                let bgCol = 'rgba(255, 255, 255, 0.01)';
                                let badgeColor = '#9ca3af';
                                let badgeBg = 'rgba(255, 255, 255, 0.06)';
                                
                                if (rec.severity === 'warning') {
                                    borderCol = 'rgba(245, 158, 11, 0.25)';
                                    bgCol = 'rgba(245, 158, 11, 0.02)';
                                    badgeColor = '#fbbf24';
                                    badgeBg = 'rgba(245, 158, 11, 0.12)';
                                } else if (rec.severity === 'success') {
                                    borderCol = 'rgba(16, 185, 129, 0.25)';
                                    bgCol = 'rgba(16, 185, 129, 0.02)';
                                    badgeColor = '#34d399';
                                    badgeBg = 'rgba(16, 185, 129, 0.12)';
                                } else if (rec.severity === 'info') {
                                    borderCol = 'rgba(59, 130, 246, 0.25)';
                                    bgCol = 'rgba(59, 130, 246, 0.02)';
                                    badgeColor = '#60a5fa';
                                    badgeBg = 'rgba(59, 130, 246, 0.12)';
                                }

                                return (
                                    <div key={rec.id} style={{ border: `1px solid ${borderCol}`, background: bgCol, borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                                            <span style={{ fontWeight: '700', fontSize: '13px', color: '#ffffff' }}>{rec.title}</span>
                                            <span style={{ background: badgeBg, color: badgeColor, fontSize: '10px', padding: '2px 8px', borderRadius: '10px', whiteSpace: 'nowrap', fontWeight: '600', border: '1px solid rgba(255,255,255,0.03)' }}>
                                                {rec.savings}
                                            </span>
                                        </div>
                                        <p style={{ margin: 0, fontSize: '12px', color: '#9ca3af', lineHeight: '1.5' }}>{rec.description}</p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                </div>

                {/* Right Column: Gamification Sidebar Achievements */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    
                    {/* Active Streak Panel */}
                    <div className="glass-panel" style={{ padding: '24px 20px', borderRadius: '12px', textAlign: 'center', background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.04), rgba(16, 185, 129, 0.04))', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                        <div style={{ fontSize: '46px', marginBottom: '8px', filter: 'drop-shadow(0 4px 10px rgba(245, 158, 11, 0.35))' }}>🔥</div>
                        <h3 style={{ margin: '0 0 6px 0', fontSize: '14px', fontWeight: '700', color: '#ffffff' }}>Sustainability Streak</h3>
                        <div style={{ fontSize: '28px', fontWeight: '800', color: '#fbbf24' }}>{currentStreak} Days</div>
                        <p style={{ margin: '8px 0 0 0', fontSize: '11px', color: '#9ca3af', lineHeight: '1.4' }}>
                            Consecutive days with at least one prompt efficiency score &ge; 90%
                        </p>
                    </div>

                    {/* Cumulative Savings Panel */}
                    <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px' }}>
                        <h4 style={{ margin: '0 0 14px 0', fontSize: '12px', fontWeight: '700', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Saved by Coach</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '12px', color: '#9ca3af', fontWeight: '500' }}>Tokens Saved:</span>
                                <span style={{ fontSize: '14px', fontWeight: '800', color: '#3b82f6' }}>{totalTokensSaved}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '12px', color: '#9ca3af', fontWeight: '500' }}>Carbon Prevented:</span>
                                <span style={{ fontSize: '14px', fontWeight: '800', color: '#10b981' }}>{totalCarbonSaved.toFixed(2)}g</span>
                            </div>
                        </div>
                    </div>

                    {/* Dynamic Achievements / Badges Panel */}
                    <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px' }}>
                        <h4 style={{ margin: '0 0 14px 0', fontSize: '12px', fontWeight: '700', color: '#ffffff', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Eco Achievements</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                            {badges.map(badge => (
                                <div key={badge.id} style={{ display: 'flex', gap: '12px', alignItems: 'center', opacity: badge.unlocked ? 1 : 0.35, transition: 'opacity 0.3s ease' }}>
                                    <div className={badge.unlocked ? "glow-green" : ""} style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'rgba(255, 255, 255, 0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', border: '1px solid rgba(255, 255, 255, 0.08)', flexShrink: 0 }}>
                                        {badge.icon}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                        <span style={{ fontSize: '13px', fontWeight: '700', color: badge.unlocked ? '#34d399' : '#d1d5db', lineHeight: '1.2' }}>{badge.name}</span>
                                        <span style={{ fontSize: '10px', color: '#9ca3af', lineHeight: '1.3', marginTop: '2px' }}>{badge.description}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                </div>

            </div>

            {/* Recent Queries and History Table */}
            <div className="glass-panel" style={{ padding: '24px', borderRadius: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#ffffff', letterSpacing: '-0.01em' }}>Logged Queries & Footprint</h3>
                    <input 
                        type="text" 
                        placeholder="Search queries..." 
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '6px', padding: '8px 14px', color: '#ffffff', fontSize: '12px', width: '240px', outline: 'none', transition: 'border-color 0.15s ease' }}
                    />
                </div>

                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', color: '#9ca3af' }}>
                                <th style={{ padding: '12px 10px', fontWeight: '600' }}>Date</th>
                                <th style={{ padding: '12px 10px', fontWeight: '600', width: '32%' }}>Prompt</th>
                                <th style={{ padding: '12px 10px', fontWeight: '600', width: '32%' }}>Response</th>
                                <th style={{ padding: '12px 10px', fontWeight: '600', textAlign: 'right' }}>Tokens</th>
                                <th style={{ padding: '12px 10px', fontWeight: '600', textAlign: 'right' }}>Carbon (g)</th>
                                <th style={{ padding: '12px 10px', fontWeight: '600', textAlign: 'center' }}>Savings</th>
                                <th style={{ padding: '12px 10px', fontWeight: '600', textAlign: 'right' }}>Score</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedHistory.length === 0 ? (
                                <tr>
                                    <td colSpan="7" style={{ padding: '24px', textAlign: 'center', color: '#9ca3af' }}>No matching records found.</td>
                                </tr>
                            ) : (
                                sortedHistory.map((item, index) => (
                                    <tr key={index} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)', verticalAlign: 'top', hover: { background: 'rgba(255, 255, 255, 0.02)' } }}>
                                        {/* Organised Relative Timestamp Display */}
                                        <td style={{ padding: '16px 10px', color: '#9ca3af', whiteSpace: 'nowrap', fontWeight: '500' }}>
                                            {formatTimestamp(item.timestamp)}
                                        </td>
                                        <td style={{ padding: '16px 10px', wordBreak: 'break-word', color: '#f3f4f6', lineHeight: '1.4' }}>
                                            <div>{item.prompt.length > 100 ? item.prompt.substring(0, 100) + '...' : item.prompt}</div>
                                            
                                            {/* Render parsed attachments/links status indicators (Module 13) */}
                                            <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                                                {item.attachedLinks > 0 && (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'rgba(59, 130, 246, 0.12)', color: '#60a5fa', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(59, 130, 246, 0.2)', fontWeight: '600' }}>
                                                        🔗 {item.attachedLinks} Link{item.attachedLinks > 1 ? 's' : ''}
                                                    </span>
                                                )}
                                                {item.attachedImages > 0 && (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'rgba(16, 185, 129, 0.12)', color: '#34d399', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(16, 185, 129, 0.2)', fontWeight: '600' }}>
                                                        🖼️ {item.attachedImages} Image{item.attachedImages > 1 ? 's' : ''}
                                                    </span>
                                                )}
                                                {item.attachedDocs > 0 && (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(245, 158, 11, 0.2)', fontWeight: '600' }}>
                                                        📎 {item.attachedDocs} Doc{item.attachedDocs > 1 ? 's' : ''}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td style={{ padding: '16px 10px', wordBreak: 'break-word', color: '#9ca3af', lineHeight: '1.4' }}>
                                            {item.response.length > 100 ? item.response.substring(0, 100) + '...' : item.response}
                                        </td>
                                        <td style={{ padding: '16px 10px', textAlign: 'right', fontWeight: '700', color: '#e5e7eb' }}>
                                            {item.totalTokens.toLocaleString()}
                                        </td>
                                        <td style={{ padding: '16px 10px', textAlign: 'right', color: '#10b981', fontWeight: '700' }}>
                                            {item.carbon.toFixed(3)}
                                        </td>
                                        <td style={{ padding: '16px 10px', textAlign: 'center' }}>
                                            {item.wasOptimized ? (
                                                <span style={{ color: '#34d399', fontSize: '11px', fontWeight: '700', background: 'rgba(16, 185, 129, 0.12)', padding: '2px 8px', borderRadius: '4px', border: '1px solid rgba(16,185,129,0.2)', whiteSpace: 'nowrap' }}>
                                                    -{item.carbonSaved.toFixed(2)}g CO₂
                                                </span>
                                            ) : (
                                                <span style={{ color: '#6b7280', fontSize: '11px' }}>-</span>
                                            )}
                                        </td>
                                        <td style={{ padding: '16px 10px', textAlign: 'right' }}>
                                            <span style={{ background: item.efficiencyScore >= 90 ? 'rgba(16, 185, 129, 0.15)' : item.efficiencyScore >= 70 ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: item.efficiencyScore >= 90 ? '#34d399' : item.efficiencyScore >= 70 ? '#fbbf24' : '#f87171', padding: '4px 10px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.05)', fontSize: '11px', fontWeight: '700', display: 'inline-block' }}>
                                                {item.efficiencyScore}%
                                            </span>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
