import React, { useState, useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';
import { PromptMeterRecommendations } from '../../utils/recommendations.js';
import { PromptMeterGamification } from '../../utils/gamification.js';

// Hand-curated mock dataset for local dashboard preview
const getMockHistory = () => {
    const mock = [];
    const now = new Date();
    for (let i = 9; i >= 0; i--) {
        const date = new Date(now);
        date.setMinutes(now.getMinutes() - (i * 150)); // scatters dates/hours
        const multiplier = (i % 3 === 0) ? 1.4 : (i % 2 === 0) ? 0.9 : 1.1;
        const isOpt = i % 3 === 0;
        const hasImg = i === 1 || i === 4;
        const hasDoc = i === 2 || i === 7;
        const hasLink = i === 3;

        mock.push({
            prompt: isOpt 
                ? "Write a python script to parse server logs." 
                : "Hello ChatGPT, could you please write write a python script to parse log files? thank you!",
            response: `Here is a lightweight Python script that parses server logs using regex...`,
            promptTokens: isOpt ? 10 : Math.round(20 * multiplier),
            responseTokens: Math.round(110 * multiplier),
            totalTokens: isOpt ? 120 : Math.round(130 * multiplier),
            electricity: parseFloat((isOpt ? 0.120 : 0.130 * multiplier).toFixed(4)),
            carbon: parseFloat((isOpt ? 0.043 : 0.047 * multiplier).toFixed(4)),
            water: parseFloat((isOpt ? 0.180 : 0.195 * multiplier).toFixed(4)),
            efficiencyScore: isOpt ? 100 : Math.round(68 + (i * 3.2) % 22),
            wasOptimized: isOpt,
            tokensSaved: isOpt ? 10 : 0,
            carbonSaved: isOpt ? 0.45 : 0,
            attachedImages: hasImg ? 1 : 0,
            attachedDocs: hasDoc ? 1 : 0,
            attachedLinks: hasLink ? 1 : 0,
            timestamp: date.toISOString()
        });
    }
    return mock;
};

// Formats timestamp into highly readable relative blocks
const formatTimestamp = (isoString) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (60 * 1000));
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24 && date.getDate() === now.getDate()) {
        return `Today at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }
    
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear()) {
        return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }

    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function App() {
    const [history, setHistory] = useState([]);
    const [filterMode, setFilterMode] = useState('daily');
    const [searchTerm, setSearchTerm] = useState('');
    const [isMockData, setIsMockData] = useState(false);
    const [activeTab, setActiveTab] = useState(() => {
        return localStorage.getItem('promptmeter_active_tab') || 'overview';
    });
    const chartRef = useRef(null);
    const chartInstance = useRef(null);

    const handleTabChange = (tabName) => {
        setActiveTab(tabName);
        localStorage.setItem('promptmeter_active_tab', tabName);
    };

    // Fetch storage entries on mount
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

    // Calculate aggregates
    const totalQueries = history.length;
    const totalTokens = history.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
    const totalElectricity = history.reduce((sum, item) => sum + (item.electricity || 0), 0);
    const totalCarbon = history.reduce((sum, item) => sum + (item.carbon || 0), 0);
    const totalWater = history.reduce((sum, item) => sum + (item.water || 0), 0);
    const avgEfficiency = totalQueries > 0 
        ? Math.round(history.reduce((sum, item) => sum + (item.efficiencyScore || 100), 0) / totalQueries)
        : 100;

    // Gamification statistics
    const totalTokensSaved = history.reduce((sum, item) => sum + (item.tokensSaved || 0), 0);
    const totalCarbonSaved = history.reduce((sum, item) => sum + (item.carbonSaved || 0), 0);
    const currentStreak = PromptMeterGamification.calculateStreak(history);
    const badges = PromptMeterGamification.checkBadges(history);
    const weeklyChallenge = PromptMeterGamification.getWeeklyChallenge(history);

    // Environmental equivalents
    const ledHours = (totalElectricity / 10).toFixed(1);
    const drivingMeters = (totalCarbon * 8.3).toFixed(1);
    const waterSips = (totalWater / 10).toFixed(0);

    // Dynamic Advisor recommendations
    const recommendations = PromptMeterRecommendations.generate(history);

    // Chart.js render engine
    useEffect(() => {
        if (history.length === 0 || !chartRef.current || activeTab !== 'overview') return;

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
                        backgroundColor: 'rgba(239, 108, 0, 0.25)', // Carbon Indicator (#EF6C00)
                        borderColor: '#EF6C00',
                        borderWidth: 1.5,
                        borderRadius: 4,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Tokens Consumed',
                        data: tokenData,
                        type: 'line',
                        borderColor: '#2E7D32', // Primary Green (#2E7D32)
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointBackgroundColor: '#2E7D32',
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
                        labels: { color: '#55605A', font: { family: 'Inter', size: 11, weight: '600' } } // Secondary Text
                    }
                },
                scales: {
                    x: {
                        grid: { color: '#DCE8DD' }, // Border Color
                        ticks: { color: '#7A857E', font: { family: 'Inter', size: 10 } } // Muted Text
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        grid: { color: '#DCE8DD' }, // Border Color
                        ticks: { color: '#EF6C00', font: { family: 'Inter', size: 10 } } // Carbon Indicator
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#2E7D32', font: { family: 'Inter', size: 10 } } // Primary Green
                    }
                }
            }
        });

        return () => {
            if (chartInstance.current) {
                chartInstance.current.destroy();
            }
        };
    }, [history, filterMode, activeTab]);

    const filteredHistory = history.filter(item => 
        item.prompt.toLowerCase().includes(searchTerm.toLowerCase()) || 
        item.response.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const sortedHistory = [...filteredHistory].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const handleClearHistory = () => {
        if (window.confirm("Are you sure you want to delete all queries in your log? This action cannot be undone.")) {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ history: [] }, () => {
                    setHistory([]);
                    setIsMockData(false);
                });
            } else {
                setHistory([]);
                setIsMockData(false);
            }
        }
    };

    const handleDeleteTurn = (timestamp) => {
        if (window.confirm("Are you sure you want to delete this query log entry?")) {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && !isMockData) {
                chrome.storage.local.get({ history: [] }, (result) => {
                    const logs = result.history || [];
                    const updatedLogs = logs.filter(item => item.timestamp !== timestamp);
                    chrome.storage.local.set({ history: updatedLogs }, () => {
                        setHistory(updatedLogs);
                    });
                });
            } else {
                setHistory(prev => prev.filter(item => item.timestamp !== timestamp));
            }
        }
    };

    // Dynamic Sustainability Rating logic
    let ratingName = "High Impact Prompter";
    let ratingColor = "#D32F2F"; // Error Red
    let ratingBg = "rgba(211, 47, 47, 0.06)";
    let ratingDescription = "Your prompt queries are carrying redundant weights, greetings, and repetitive phrases. ACCEPT the coach's suggestions to optimize your compute score.";

    if (avgEfficiency >= 90) {
        ratingName = "Optimal Eco-Prompter";
        ratingColor = "#2E7D32"; // Primary Green
        ratingBg = "rgba(46, 125, 50, 0.06)";
        ratingDescription = "Splendid! Your prompting structure avoids greetings and polite fillers, maximizing reasoning tokens while minimizing cooling water and carbon footprints.";
    } else if (avgEfficiency >= 70) {
        ratingName = "Eco-Conscious Prompter";
        ratingColor = "#F9A825"; // Warning Orange
        ratingBg = "rgba(249, 168, 37, 0.06)";
        ratingDescription = "Great start. You can save up to 15% more token computations by avoiding polite phrasing (please, thank you) and eliminating redundant formatting constraints.";
    }

    // Split recommendations by severity
    const criticalFixes = recommendations.filter(r => r.severity === 'warning');
    const efficiencyBestPractices = recommendations.filter(r => r.severity !== 'warning');

    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: '#F7F9F4', color: '#1B1F1C', fontFamily: 'Inter, sans-serif' }}>
            
            {/* Sidebar Navigation Panel (#F2F7F2 Background, #DCE8DD Border) */}
            <div style={{ width: '260px', borderRight: '1px solid #DCE8DD', background: '#F2F7F2', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                {/* Brand Header */}
                <div style={{ padding: '24px', display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid #DCE8DD' }}>
                    <span style={{ fontSize: '20px' }}>🌿</span>
                    <div>
                        <div style={{ fontSize: '15px', fontWeight: '800', color: '#1B1F1C', fontFamily: 'Sora, sans-serif', letterSpacing: '-0.02em' }}>PromptMeter</div>
                        <div style={{ fontSize: '10px', color: '#2E7D32', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px', fontWeight: '700' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2E7D32', display: 'inline-block' }}></span>
                            COACH ACTIVE
                        </div>
                    </div>
                </div>

                {/* Nav Links */}
                <div style={{ padding: '24px 14px', display: 'flex', flexDirection: 'column', gap: '6px', flexGrow: 1 }}>
                    <button 
                        onClick={() => handleTabChange('overview')}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', background: activeTab === 'overview' ? '#E8F5E9' : 'transparent', border: 'none', borderLeft: activeTab === 'overview' ? '3px solid #2E7D32' : '3px solid transparent', color: activeTab === 'overview' ? '#2E7D32' : '#55605A', padding: '12px 16px', borderRadius: activeTab === 'overview' ? '0 12px 12px 0' : '12px', fontSize: '13px', fontWeight: '700', textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s ease' }}
                    >
                        <span>📊</span> Overview
                    </button>
                    <button 
                        onClick={() => handleTabChange('queries')}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', background: activeTab === 'queries' ? '#E8F5E9' : 'transparent', border: 'none', borderLeft: activeTab === 'queries' ? '3px solid #2E7D32' : '3px solid transparent', color: activeTab === 'queries' ? '#2E7D32' : '#55605A', padding: '12px 16px', borderRadius: activeTab === 'queries' ? '0 12px 12px 0' : '12px', fontSize: '13px', fontWeight: '700', textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s ease' }}
                    >
                        <span>📂</span> Queries Log
                    </button>
                    <button 
                        onClick={() => handleTabChange('insights')}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%', background: activeTab === 'insights' ? '#E8F5E9' : 'transparent', border: 'none', borderLeft: activeTab === 'insights' ? '3px solid #2E7D32' : '3px solid transparent', color: activeTab === 'insights' ? '#2E7D32' : '#55605A', padding: '12px 16px', borderRadius: activeTab === 'insights' ? '0 12px 12px 0' : '12px', fontSize: '13px', fontWeight: '700', textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s ease' }}
                    >
                        <span>🧠</span> Advisor Insights
                    </button>
                </div>

                {/* Sidebar Footer info */}
                <div style={{ padding: '20px 24px', borderTop: '1px solid #DCE8DD', fontSize: '11px', color: '#7A857E', fontWeight: '500' }}>
                    Version 1.0.0
                </div>
            </div>

            {/* Main Content Workspace Panel (#F7F9F4 Background) */}
            <div style={{ flexGrow: 1, padding: '40px 32px', overflowY: 'auto' }}>
                
                {/* Tab: Overview Panel */}
                {activeTab === 'overview' && (
                    <div>
                        {/* Premium White Cards Grid (#FFFFFF Background, #DCE8DD Border, 18px Radius, Soft green shadow) */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '32px' }}>
                            <div className="glass-panel kpi-card">
                                <div style={{ fontSize: '16px', color: '#55605A', letterSpacing: '-0.01em', marginBottom: '6px', fontWeight: '600' }}>Logged Queries</div>
                                <div style={{ fontSize: '36px', fontWeight: '800', color: '#1B1F1C', fontFamily: 'Sora, sans-serif', letterSpacing: '-0.02em' }}>{totalQueries}</div>
                            </div>
                            <div className="glass-panel kpi-card">
                                <div style={{ fontSize: '16px', color: '#55605A', letterSpacing: '-0.01em', marginBottom: '6px', fontWeight: '600' }}>Total Tokens</div>
                                <div style={{ fontSize: '36px', fontWeight: '800', color: '#1B1F1C', fontFamily: 'Sora, sans-serif', letterSpacing: '-0.02em' }}>{totalTokens.toLocaleString()}</div>
                            </div>
                            <div className="glass-panel kpi-card">
                                <div style={{ fontSize: '16px', color: '#55605A', letterSpacing: '-0.01em', marginBottom: '6px', fontWeight: '600' }}>Carbon Footprint</div>
                                <div style={{ fontSize: '36px', fontWeight: '800', color: '#EF6C00', fontFamily: 'Sora, sans-serif', letterSpacing: '-0.02em' }}>
                                    {totalCarbon.toFixed(1)}
                                    <span style={{ fontSize: '16px', color: '#55605A', fontWeight: '600', marginLeft: '4px' }}>g CO₂</span>
                                </div>
                            </div>
                            <div className="glass-panel kpi-card" style={{ border: '1px solid #81C784' }}>
                                <div style={{ fontSize: '16px', color: '#2E7D32', letterSpacing: '-0.01em', marginBottom: '6px', fontWeight: '700' }}>Avg Efficiency</div>
                                <div style={{ fontSize: '36px', fontWeight: '800', color: '#2E7D32', fontFamily: 'Sora, sans-serif', letterSpacing: '-0.02em' }}>{avgEfficiency}%</div>
                            </div>
                        </div>

                        {/* Split Columns Grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '24px', alignItems: 'start' }}>
                            
                            {/* Main (Left) Columns */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                                {/* Challenge Panel */}
                                <div className="glass-panel">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span style={{ fontSize: '16px' }}>🏆</span>
                                            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#1B1F1C' }}>
                                                {weeklyChallenge.title}
                                            </h3>
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#2E7D32', fontWeight: '700' }}>
                                            Saved: {weeklyChallenge.currentValue} / 2.0g target
                                        </div>
                                    </div>
                                    <div style={{ width: '100%', height: '6px', background: '#EEF5EC', borderRadius: '12px', overflow: 'hidden' }}>
                                        <div style={{ width: `${weeklyChallenge.progress}%`, height: '100%', background: '#2E7D32', borderRadius: '12px' }}></div>
                                    </div>
                                </div>

                                {/* Graph Panel */}
                                <div className="glass-panel">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#1B1F1C' }}>Environmental Footprint Over Time</h3>
                                        <div style={{ display: 'flex', background: '#EEF5EC', border: '1px solid #DCE8DD', borderRadius: '12px', padding: '3px' }}>
                                            <button style={{ background: filterMode === 'daily' ? '#FFFFFF' : 'transparent', border: 'none', color: filterMode === 'daily' ? '#2E7D32' : '#7A857E', padding: '6px 14px', fontSize: '11px', fontWeight: '700', borderRadius: '10px', cursor: 'pointer', transition: 'all 0.2s ease', boxShadow: filterMode === 'daily' ? '0 2px 6px rgba(46,125,50,0.06)' : 'none' }} onClick={() => setFilterMode('daily')}>Daily</button>
                                            <button style={{ background: filterMode === 'weekly' ? '#FFFFFF' : 'transparent', border: 'none', color: filterMode === 'weekly' ? '#2E7D32' : '#7A857E', padding: '6px 14px', fontSize: '11px', fontWeight: '700', borderRadius: '10px', cursor: 'pointer', transition: 'all 0.2s ease', boxShadow: filterMode === 'weekly' ? '0 2px 6px rgba(46,125,50,0.06)' : 'none' }} onClick={() => setFilterMode('weekly')}>Weekly</button>
                                            <button style={{ background: filterMode === 'monthly' ? '#FFFFFF' : 'transparent', border: 'none', color: filterMode === 'monthly' ? '#2E7D32' : '#7A857E', padding: '6px 14px', fontSize: '11px', fontWeight: '700', borderRadius: '10px', cursor: 'pointer', transition: 'all 0.2s ease', boxShadow: filterMode === 'monthly' ? '0 2px 6px rgba(46,125,50,0.06)' : 'none' }} onClick={() => setFilterMode('monthly')}>Monthly</button>
                                        </div>
                                    </div>
                                    <div style={{ height: '260px', position: 'relative' }}>
                                        <canvas ref={chartRef}></canvas>
                                    </div>
                                </div>
                            </div>

                            {/* Sidebar (Right) Columns */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                                {/* Streak Card */}
                                <div className="glass-panel" style={{ textAlign: 'center', background: 'linear-gradient(135deg, #EEF5EC, #FFFFFF)', border: '1px solid #DCE8DD' }}>
                                    <div style={{ fontSize: '32px', marginBottom: '8px' }}>🔥</div>
                                    <div style={{ fontSize: '14px', color: '#55605A', fontWeight: '600', marginBottom: '4px' }}>Coaching Streak</div>
                                    <div style={{ fontSize: '30px', fontWeight: '800', color: '#FBBF24', fontFamily: 'Sora, sans-serif' }}>{currentStreak} Days</div>
                                </div>

                                {/* Coach Savings */}
                                <div className="glass-panel">
                                    <h4 style={{ margin: '0 0 14px 0', fontSize: '12px', fontWeight: '700', color: '#2E7D32', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Saved by Coach</h4>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ color: '#55605A', fontWeight: '500' }}>Tokens Saved</span>
                                            <span style={{ fontWeight: '700', color: '#2E7D32', fontSize: '14px' }}>{totalTokensSaved}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ color: '#55605A', fontWeight: '500' }}>Carbon Saved</span>
                                            <span style={{ fontWeight: '700', color: '#EF6C00', fontSize: '14px' }}>{totalCarbonSaved.toFixed(1)}g</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                )}

                {/* Tab: Queries Log Panel */}
                {activeTab === 'queries' && (
                    <div className="glass-panel">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#1B1F1C' }}>Queries Log</h3>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                <input 
                                    type="text" 
                                    placeholder="Search queries..." 
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    style={{ background: '#F7F9F4', border: '1px solid #DCE8DD', borderRadius: '12px', padding: '8px 16px', color: '#1B1F1C', fontSize: '13px', width: '240px', outline: 'none' }}
                                />
                                {history.length > 0 && (
                                    <button 
                                        onClick={handleClearHistory}
                                        style={{ background: 'rgba(211, 47, 47, 0.08)', color: '#D32F2F', border: '1px solid rgba(211, 47, 47, 0.2)', borderRadius: '12px', padding: '8px 14px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s ease' }}
                                    >
                                        🗑️ Clear All Logs
                                    </button>
                                )}
                            </div>
                        </div>

                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid #DCE8DD', color: '#55605A' }}>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase' }}>Date</th>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase', width: '50%' }}>Prompt</th>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase', textAlign: 'right' }}>Tokens</th>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase', textAlign: 'right' }}>Carbon</th>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase', textAlign: 'center' }}>Savings</th>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase', textAlign: 'right' }}>Score</th>
                                        <th style={{ padding: '12px 10px', fontWeight: '600', fontSize: '11px', textTransform: 'uppercase', textAlign: 'center' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedHistory.length === 0 ? (
                                        <tr>
                                            <td colSpan="7" style={{ padding: '24px', textAlign: 'center', color: '#7A857E' }}>No matching records found.</td>
                                        </tr>
                                    ) : (
                                        sortedHistory.map((item, index) => (
                                            <tr key={index} style={{ borderBottom: '1px solid #DCE8DD', verticalAlign: 'top' }}>
                                                <td style={{ padding: '16px 10px', color: '#7A857E', whiteSpace: 'nowrap', fontWeight: '500' }}>
                                                    {formatTimestamp(item.timestamp)}
                                                </td>
                                                <td style={{ padding: '16px 10px', wordBreak: 'break-word', color: '#1B1F1C', lineHeight: '1.4' }}>
                                                    <div>{item.prompt.length > 100 ? item.prompt.substring(0, 100) + '...' : item.prompt}</div>
                                                    <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                                                        {item.attachedLinks > 0 && (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#EEF5EC', color: '#1976D2', fontSize: '10px', padding: '2px 6px', borderRadius: '6px', border: '1px solid #DCE8DD', fontWeight: '700' }}>
                                                                🔗 {item.attachedLinks} URL
                                                            </span>
                                                        )}
                                                        {item.attachedImages > 0 && (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#EEF5EC', color: '#2E7D32', fontSize: '10px', padding: '2px 6px', borderRadius: '6px', border: '1px solid #DCE8DD', fontWeight: '700' }}>
                                                                🖼️ {item.attachedImages} Img
                                                            </span>
                                                        )}
                                                        {item.attachedDocs > 0 && (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: '#EEF5EC', color: '#EF6C00', fontSize: '10px', padding: '2px 6px', borderRadius: '6px', border: '1px solid #DCE8DD', fontWeight: '700' }}>
                                                                📎 {item.attachedDocs} Doc
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td style={{ padding: '16px 10px', textAlign: 'right', fontWeight: '600', color: '#1B1F1C' }}>
                                                    {item.totalTokens.toLocaleString()}
                                                </td>
                                                <td style={{ padding: '16px 10px', textAlign: 'right', color: '#EF6C00', fontWeight: '600' }}>
                                                    {item.carbon.toFixed(2)}g
                                                </td>
                                                <td style={{ padding: '16px 10px', textAlign: 'center' }}>
                                                    {item.wasOptimized ? (
                                                        <span style={{ color: '#2E7D32', fontSize: '11px', fontWeight: '700', background: '#EEF5EC', padding: '2px 6px', borderRadius: '6px', border: '1px solid rgba(46,125,50,0.15)', whiteSpace: 'nowrap' }}>
                                                            -{item.carbonSaved.toFixed(2)}g
                                                        </span>
                                                    ) : (
                                                        <span style={{ color: '#7A857E' }}>-</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '16px 10px', textAlign: 'right' }}>
                                                    <span style={{ background: item.efficiencyScore >= 90 ? 'rgba(46, 125, 50, 0.08)' : item.efficiencyScore >= 70 ? 'rgba(249, 168, 37, 0.08)' : 'rgba(211, 47, 47, 0.08)', color: item.efficiencyScore >= 90 ? '#43A047' : item.efficiencyScore >= 70 ? '#F9A825' : '#D32F2F', padding: '4px 10px', borderRadius: '12px', border: '1px solid #DCE8DD', fontSize: '11px', fontWeight: '700', display: 'inline-block' }}>
                                                        {item.efficiencyScore}%
                                                    </span>
                                                </td>
                                                <td style={{ padding: '16px 10px', textAlign: 'center' }}>
                                                    <button 
                                                        onClick={() => handleDeleteTurn(item.timestamp)}
                                                        title="Delete query log entry"
                                                        style={{ 
                                                            background: 'rgba(211, 47, 47, 0.08)', 
                                                            color: '#D32F2F', 
                                                            border: '1px solid rgba(211, 47, 47, 0.2)', 
                                                            borderRadius: '8px', 
                                                            padding: '6px 10px', 
                                                            fontSize: '12px', 
                                                            cursor: 'pointer',
                                                            transition: 'all 0.15s ease'
                                                        }}
                                                    >
                                                        🗑️
                                                    </button>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Tab: Advisor Insights & Achievements Panel (Human-Designed Version) */}
                {activeTab === 'insights' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
                        
                        {/* 1. Health Score Banner & Sustainability Rating */}
                        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '32px', background: '#FFFFFF', borderLeft: `6px solid ${ratingColor}` }}>
                            {/* Health Gauge Ring visual representation */}
                            <div style={{ width: '90px', height: '90px', borderRadius: '50%', background: ratingBg, border: `3px solid ${ratingColor}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <span style={{ fontSize: '24px', fontWeight: '800', color: ratingColor, fontFamily: 'Sora, sans-serif', lineHeight: '1' }}>{avgEfficiency}%</span>
                                <span style={{ fontSize: '9px', fontWeight: '700', color: ratingColor, textTransform: 'uppercase', marginTop: '2px', letterSpacing: '0.05em' }}>Health</span>
                            </div>

                            {/* Summary Text block */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '800', fontFamily: 'Sora, sans-serif', color: '#1B1F1C' }}>AI Sustainability Coach Dashboard</h2>
                                    <span style={{ background: ratingBg, color: ratingColor, fontSize: '10px', fontWeight: '800', padding: '2px 8px', borderRadius: '6px', textTransform: 'uppercase', letterSpacing: '0.05em', border: `1px solid ${ratingColor}` }}>
                                        {ratingName}
                                    </span>
                                </div>
                                <p style={{ margin: 0, fontSize: '13px', color: '#55605A', lineHeight: '1.6', maxWidth: '780px' }}>{ratingDescription}</p>
                            </div>
                        </div>

                        {/* 2. Structured Two-Column Content Grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '28px', alignItems: 'start' }}>
                            
                            {/* Left Pane: Categorized Coaching Recommendations */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                                
                                {/* A. Critical Optimization Flags */}
                                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #DCE8DD', paddingBottom: '12px' }}>
                                        <span style={{ fontSize: '18px' }}>⚠️</span>
                                        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '800', color: '#1B1F1C' }}>Critical Optimization Warnings</h3>
                                    </div>
                                    
                                    {criticalFixes.length === 0 ? (
                                        <div style={{ padding: '16px', textAlign: 'center', color: '#7A857E', fontSize: '13px', background: '#F9FCF8', borderRadius: '12px', border: '1px solid #DCE8DD' }}>
                                            🎉 Excellent work! No warnings detected. Your prompting cycles are carbon efficient.
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                            {criticalFixes.map((rec) => (
                                                <div key={rec.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', background: 'rgba(249, 168, 37, 0.05)', borderRadius: '12px', border: '1px solid rgba(249, 168, 37, 0.25)' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                        <span style={{ fontWeight: '700', fontSize: '13px', color: '#1B1F1C' }}>{rec.title}</span>
                                                        <span style={{ background: '#FFFFFF', color: '#F9A825', border: '1px solid #DCE8DD', fontSize: '10px', padding: '2px 8px', borderRadius: '6px', fontWeight: '700' }}>
                                                            {rec.savings}
                                                        </span>
                                                    </div>
                                                    <p style={{ margin: 0, fontSize: '12px', color: '#55605A', lineHeight: '1.5' }}>{rec.description}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* B. General Eco-Efficiency Best Practices */}
                                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #DCE8DD', paddingBottom: '12px' }}>
                                        <span style={{ fontSize: '18px' }}>💡</span>
                                        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '800', color: '#1B1F1C' }}>Efficiency Best Practices</h3>
                                    </div>
                                    
                                    {efficiencyBestPractices.length === 0 ? (
                                        <div style={{ padding: '16px', textAlign: 'center', color: '#7A857E', fontSize: '13px' }}>
                                            No diagnostics logs available yet. Make more queries to generate tips.
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                            {efficiencyBestPractices.map((rec) => {
                                                const borderCol = rec.severity === 'success' ? 'rgba(46, 125, 50, 0.2)' : 'rgba(25, 118, 210, 0.2)';
                                                const badgeCol = rec.severity === 'success' ? '#2E7D32' : '#1976D2';
                                                const bgCol = rec.severity === 'success' ? 'rgba(46, 125, 50, 0.03)' : 'rgba(25, 118, 210, 0.03)';
                                                
                                                return (
                                                    <div key={rec.id} style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', background: bgCol, borderRadius: '12px', border: `1px solid ${borderCol}` }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <span style={{ fontWeight: '700', fontSize: '13px', color: '#1B1F1C' }}>{rec.title}</span>
                                                            <span style={{ background: '#FFFFFF', color: badgeCol, border: '1px solid #DCE8DD', fontSize: '10px', padding: '2px 8px', borderRadius: '6px', fontWeight: '700' }}>
                                                                {rec.savings}
                                                            </span>
                                                        </div>
                                                        <p style={{ margin: 0, fontSize: '12px', color: '#55605A', lineHeight: '1.5' }}>{rec.description}</p>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                            </div>

                            {/* Right Pane: Achievements Grid Card & Milestones */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                                
                                {/* Badges Grid Container */}
                                <div className="glass-panel" style={{ padding: '24px' }}>
                                    <div style={{ borderBottom: '1px solid #DCE8DD', paddingBottom: '12px', marginBottom: '16px' }}>
                                        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: '800', color: '#1B1F1C' }}>Eco Milestones</h3>
                                    </div>
                                    
                                    {/* 2-Column Grid */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                        {badges.map(badge => (
                                            <div 
                                                key={badge.id} 
                                                style={{ 
                                                    display: 'flex', 
                                                    flexDirection: 'column', 
                                                    alignItems: 'center', 
                                                    padding: '12px 8px', 
                                                    background: badge.unlocked ? '#F9FCF8' : '#F7F9F4', 
                                                    border: badge.unlocked ? '1px solid #81C784' : '1px solid #DCE8DD', 
                                                    borderRadius: '12px',
                                                    opacity: badge.unlocked ? 1 : 0.6,
                                                    textAlign: 'center',
                                                    position: 'relative'
                                                }}
                                            >
                                                {/* Lock indicator */}
                                                {!badge.unlocked && (
                                                    <span style={{ position: 'absolute', top: '4px', right: '4px', fontSize: '9px' }}>🔒</span>
                                                )}
                                                
                                                {/* Icon Bubble */}
                                                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: badge.unlocked ? '#E8F5E9' : '#EEF5EC', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', border: badge.unlocked ? '1px solid #A5D6A7' : '1px solid #DCE8DD', marginBottom: '8px' }}>
                                                    {badge.icon}
                                                </div>

                                                <span style={{ fontSize: '11px', fontWeight: '800', color: badge.unlocked ? '#2E7D32' : '#55605A', lineHeight: '1.2' }}>{badge.name}</span>
                                                <span style={{ fontSize: '9px', color: '#7A857E', marginTop: '4px', lineHeight: '1.2' }}>{badge.description}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Gamified Milestones Stats Summary */}
                                <div className="glass-panel" style={{ padding: '20px', background: 'linear-gradient(135deg, #EEF5EC, #FFFFFF)', border: '1px solid #DCE8DD' }}>
                                    <h4 style={{ margin: '0 0 12px 0', fontSize: '11px', fontWeight: '800', color: '#2E7D32', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Coaching Summary</h4>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', color: '#55605A' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span>Active Streak:</span>
                                            <span style={{ fontWeight: '700', color: '#1B1F1C' }}>{currentStreak} Days</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span>Eco-Badges Unlocked:</span>
                                            <span style={{ fontWeight: '700', color: '#2E7D32' }}>{badges.filter(b => b.unlocked).length} / {badges.length}</span>
                                        </div>
                                    </div>
                                </div>

                            </div>

                        </div>
                    </div>
                )}

            </div>
        </div>
    );
}
