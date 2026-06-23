// charts.js - Chart rendering using Chart.js

const formatDisplayNumber = window.formatDisplayNumber || ((value, options = {}) => {
    if (value === null || value === undefined || value === '') return '';
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) return String(value);
    const decimals = Number.isInteger(options.decimals)
        ? options.decimals
        : (Number.isInteger(numericValue) ? 0 : 2);
    return numericValue.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: false
    });
});

if (window.Chart?.defaults) {
    window.Chart.defaults.locale = 'en-US';
}

/**
 * Render Sprint Report Chart
 */
let sprintChartInstance = null; // Track chart instance

window.renderSprintChart = function (data) {
    const ctx = document.getElementById('sprint-chart');
    if (!ctx) return;

    // Destroy previous chart instance to prevent memory leaks and errors
    if (sprintChartInstance) {
        sprintChartInstance.destroy();
        sprintChartInstance = null;
    }

    // Group data by sprint
    const sprints = {};
    data.forEach(row => {
        if (!sprints[row.sprint]) {
            sprints[row.sprint] = {
                confirmed: 0,
                unconfirmed: 0
            };
        }
        sprints[row.sprint].confirmed += row.confirmed_points;
        sprints[row.sprint].unconfirmed += row.unconfirmed_points;
    });

    const labels = Object.keys(sprints);
    const confirmedData = labels.map(sprint => sprints[sprint].confirmed);
    const unconfirmedData = labels.map(sprint => sprints[sprint].unconfirmed);

    sprintChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Confirmed Points',
                    data: confirmedData,
                    backgroundColor: 'rgba(16, 185, 129, 0.8)',
                    borderColor: 'rgba(16, 185, 129, 1)',
                    borderWidth: 2
                },
                {
                    label: 'Unconfirmed Points',
                    data: unconfirmedData,
                    backgroundColor: 'rgba(245, 158, 11, 0.8)',
                    borderColor: 'rgba(245, 158, 11, 1)',
                    borderWidth: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: '#a0a0c0',
                        font: {
                            family: 'Inter',
                            size: 12
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 26, 46, 0.95)',
                    titleColor: '#ffffff',
                    bodyColor: '#a0a0c0',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true
                }
            },
            scales: {
                x: {
                    stacked: false,
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#a0a0c0',
                        font: {
                            family: 'Inter'
                        }
                    }
                },
                y: {
                    stacked: false,
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        borderDash: [5, 5]
                    },
                    ticks: {
                        color: '#a0a0c0',
                        font: {
                            family: 'Inter'
                        }
                    }
                }
            }
        }
    });
};

/**
 * Render Productivity Report Chart
 */
let productivityChartInstance = null; // Track chart instance

window.renderProductivityChart = function (data) {
    const ctx = document.getElementById('productivity-chart');
    if (!ctx) return;

    // Destroy previous chart instance
    if (productivityChartInstance) {
        productivityChartInstance.destroy();
        productivityChartInstance = null;
    }

    const labels = data.map(row => row.assignee);
    const productivityData = data.map(row => row.productivity_percentage);

    // Generate colors
    const colors = labels.map((_, index) => {
        const hue = (index * 360 / labels.length) % 360;
        return `hsla(${hue}, 70%, 60%, 0.8)`;
    });

    const borderColors = labels.map((_, index) => {
        const hue = (index * 360 / labels.length) % 360;
        return `hsla(${hue}, 70%, 60%, 1)`;
    });

    productivityChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                label: 'Productivity %',
                data: productivityData,
                backgroundColor: colors,
                borderColor: borderColors,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            plugins: {
                legend: {
                    display: true,
                    position: 'right',
                    labels: {
                        color: '#a0a0c0',
                        font: {
                            family: 'Inter',
                            size: 12
                        },
                        padding: 15,
                        generateLabels: function (chart) {
                            const data = chart.data;
                            return data.labels.map((label, i) => {
                                const value = data.datasets[0].data[i];
                                return {
                                    text: `${label}: ${value}%`,
                                    fillStyle: data.datasets[0].backgroundColor[i],
                                    strokeStyle: data.datasets[0].borderColor[i],
                                    lineWidth: 2,
                                    hidden: false,
                                    index: i
                                };
                            });
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(26, 26, 46, 0.95)',
                    titleColor: '#ffffff',
                    bodyColor: '#a0a0c0',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            return `${context.label}: ${context.parsed}%`;
                        }
                    }
                }
            }
        }
    });
};

/**
 * Burndown Chart Instance Tracker
 */
const burndownChartInstances = new Map();

/**
 * Render Burndown Chart for a Sprint
 * @param {string} containerId - The ID of the container element
 * @param {Object} sprintData - Sprint information { name, startDate, endDate }
 * @param {Array} tasksData - Array of tasks with Done Date info
 * @param {Object} options - { pointField, dateField, statusField }
 */
window.renderBurndownChart = function(containerId, sprintData, tasksData, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error('[Burndown] Container not found:', containerId);
        return;
    }

    // Destroy previous chart if exists
    if (burndownChartInstances.has(containerId)) {
        burndownChartInstances.get(containerId).destroy();
        burndownChartInstances.delete(containerId);
    }

    const { name: sprintName, startDate, endDate } = sprintData;
    const { 
        pointField = 'Product Point',
        dateField = 'Ngày Làm',
        statusField = 'Task Status'
    } = options;
    
    // Debug: Log sample task data
    if (tasksData.length > 0) {
        const sampleTask = tasksData[0];
        console.log(`[Burndown] ${sprintName} - Sample task:`, {
            status: sampleTask[statusField],
            dateValue: sampleTask[dateField],
            points: sampleTask[pointField],
            allKeys: Object.keys(sampleTask)
        });
    }

    // Parse sprint dates
    const sprintStart = new Date(startDate);
    const sprintEnd = new Date(endDate);
    
    if (isNaN(sprintStart.getTime()) || isNaN(sprintEnd.getTime())) {
        container.innerHTML = `<div style="padding:20px;color:#f59e0b;text-align:center;">
            ⚠️ Sprint "${sprintName}" không có ngày bắt đầu/kết thúc hợp lệ
        </div>`;
        return;
    }

    // Generate all dates in sprint range
    const sprintDates = [];
    const currentDate = new Date(sprintStart);
    while (currentDate <= sprintEnd) {
        sprintDates.push(new Date(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
    }

    if (sprintDates.length === 0) {
        container.innerHTML = `<div style="padding:20px;color:#ef4444;text-align:center;">
            ❌ Sprint "${sprintName}" không có ngày hợp lệ
        </div>`;
        return;
    }

    // Calculate total points at sprint start
    // Only count tasks that have "Ngày Làm" (date field)
    let totalPoints = 0;
    let tasksWithDate = 0;
    tasksData.forEach(task => {
        const dateValue = task[dateField];
        if (!dateValue) return; // Skip tasks without date
        
        tasksWithDate++;
        const points = parseFloat(task[pointField]) || 1; // Default 1 point per task if no points
        totalPoints += points;
    });

    if (totalPoints === 0) {
        totalPoints = tasksWithDate || tasksData.length; // Fallback to task count
    }
    
    console.log(`[Burndown] ${sprintName}: ${tasksWithDate}/${tasksData.length} tasks have dates, total ${totalPoints} points`);

    // Calculate ideal burndown (straight line from total to 0)
    const pointsPerDay = totalPoints / (sprintDates.length - 1 || 1);
    const idealLine = sprintDates.map((_, idx) => Math.max(0, totalPoints - (pointsPerDay * idx)));

    // Calculate actual burndown based on completion dates
    const actualLine = [];
    let remainingPoints = totalPoints;
    
    // Group completed tasks by date (only Done/DoneQC status)
    const completedByDate = new Map();
    let doneTasksCount = 0;
    
    tasksData.forEach(task => {
        const status = task[statusField];
        // Only check for Done or DoneQC status
        const isDone = status && (
            status === 'Done' ||
            status === 'DoneQC' ||
            status.toLowerCase() === 'done' ||
            status.toLowerCase() === 'doneqc'
        );
        
        if (isDone) {
            doneTasksCount++;
            let doneDate = null;
            
            // Use the dateField (Ngày Làm) - this is manually entered by producer
            const dateValue = task[dateField];
            
            // Skip if no date value (required for burndown)
            if (!dateValue) return;
            
            if (dateValue) {
                // Handle different date formats
                if (typeof dateValue === 'object' && dateValue.end) {
                    doneDate = new Date(dateValue.end);
                } else if (typeof dateValue === 'object' && dateValue.start) {
                    doneDate = new Date(dateValue.start);
                } else if (typeof dateValue === 'string') {
                    // Parse various string formats
                    doneDate = new Date(dateValue);
                    // Handle date range strings like "2024-01-01 → 2024-01-05"
                    if (isNaN(doneDate.getTime()) && dateValue.includes('→')) {
                        const parts = dateValue.split('→');
                        doneDate = new Date(parts[0].trim()); // Use start date of range
                    }
                }
            }

            if (doneDate && !isNaN(doneDate.getTime())) {
                const dateKey = doneDate.toISOString().split('T')[0];
                const points = parseFloat(task[pointField]) || 1;
                completedByDate.set(dateKey, (completedByDate.get(dateKey) || 0) + points);
            }
        }
    });
    
    console.log(`[Burndown] ${sprintName}: Found ${doneTasksCount} done tasks, completion dates:`, [...completedByDate.entries()]);

    // Build actual line
    remainingPoints = totalPoints;
    sprintDates.forEach(date => {
        const dateKey = date.toISOString().split('T')[0];
        const completedPoints = completedByDate.get(dateKey) || 0;
        remainingPoints -= completedPoints;
        actualLine.push(Math.max(0, remainingPoints));
    });

    // Format date labels
    const dateLabels = sprintDates.map(d => {
        const day = d.getDate();
        const month = d.getMonth() + 1;
        return `${day}/${month}`;
    });

    // Create canvas
    const canvasId = `burndown-canvas-${containerId}`;
    container.innerHTML = `
        <div style="padding:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h4 style="margin:0;color:#f1f5f9;font-size:1rem;">🔥 Burndown Chart - ${sprintName}</h4>
                <div style="display:flex;gap:16px;font-size:0.8rem;">
                    <span style="color:#60a5fa;">📊 Tổng: ${formatDisplayNumber(totalPoints, { decimals: 1 })} points</span>
                    <span style="color:#4ade80;">✅ Còn lại: ${formatDisplayNumber(actualLine[actualLine.length-1] || 0, { decimals: 1 })} points</span>
                </div>
            </div>
            <canvas id="${canvasId}" style="max-height:300px;"></canvas>
            <div style="margin-top:12px;display:flex;gap:20px;justify-content:center;font-size:0.75rem;color:#94a3b8;">
                <span><span style="display:inline-block;width:20px;height:3px;background:#60a5fa;margin-right:6px;vertical-align:middle;"></span>Ideal</span>
                <span><span style="display:inline-block;width:20px;height:3px;background:#f97316;margin-right:6px;vertical-align:middle;"></span>Actual</span>
            </div>
        </div>
    `;

    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dateLabels,
            datasets: [
                {
                    label: 'Ideal',
                    data: idealLine,
                    borderColor: '#60a5fa',
                    backgroundColor: 'rgba(96, 165, 250, 0.1)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    tension: 0,
                    fill: false
                },
                {
                    label: 'Actual',
                    data: actualLine,
                    borderColor: '#f97316',
                    backgroundColor: 'rgba(249, 115, 22, 0.2)',
                    borderWidth: 3,
                    pointRadius: 4,
                    pointBackgroundColor: '#f97316',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1,
                    tension: 0.1,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2.5,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#94a3b8',
                    borderColor: '#334155',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${formatDisplayNumber(context.parsed.y, { decimals: 1 })} points`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#64748b',
                        font: { family: 'Inter', size: 11 }
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#64748b',
                        font: { family: 'Inter', size: 11 }
                    }
                }
            }
        }
    });

    burndownChartInstances.set(containerId, chart);
    
    // Calculate points completed  
    const totalCompleted = [...completedByDate.values()].reduce((sum, p) => sum + p, 0);
    
    console.log(`[Burndown] Rendered chart for ${sprintName}:`, { 
        totalPoints, 
        totalCompleted,
        remainingPoints: actualLine[actualLine.length - 1],
        daysInSprint: sprintDates.length,
        tasksCount: tasksData.length,
        doneTasksCount,
        completedDates: [...completedByDate.entries()],
        sprintRange: `${sprintDates[0]?.toISOString().split('T')[0]} to ${sprintDates[sprintDates.length-1]?.toISOString().split('T')[0]}`
    });
};

/**
 * Destroy a specific burndown chart
 */
window.destroyBurndownChart = function(containerId) {
    if (burndownChartInstances.has(containerId)) {
        burndownChartInstances.get(containerId).destroy();
        burndownChartInstances.delete(containerId);
    }
};
