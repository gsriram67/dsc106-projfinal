const dataUrl       = "NCHS_-_Drug_Poisoning_Mortality_by_County__United_States_20260522.csv";
const urbanRuralUrl = "County_Urban_Rural.csv";

const state = {
    rows: [],
    years: [],
    series: [],
    currentStep: 0,
};

// Persistent SVG references — created once in initChart(), updated in updateChart()
const chart = {
    svg:         null,
    xScale:      null,
    yScale:      null,
    margin:      null,
    paths:       {},  // key → { el, totalLen }
    dots:        {},  // key → [{ el, year, value }]
    annotations: [],  // [{ year, g }]
    gapG:        null,
    gapLine:     null,
    gapTickTop:  null,
    gapTickBot:  null,
    gapText:     null,
    focusLabel:  null,
};

const ANNOTATIONS = [
    { year: 2007, label: "Purdue plea" },
    { year: 2010, label: "OxyContin Rx" },
    { year: 2014, label: "Fentanyl surge" },
];

const chartContainer  = document.querySelector("#chart");
const legendContainer = document.querySelector("#legend");
const chartCaption    = document.querySelector("#chart-caption");

const urBands = [
    { key: "rural", label: "Rural", color: "#4472C4" },
    { key: "urban", label: "Urban", color: "#D97706" },
];

const DRAW_MS  = 900;

const STEP_CONFIGS = [
    { targetYear: 1999, emphasizedKey: null,    showGap: false },
    { targetYear: 2007, emphasizedKey: null,    showGap: false },
    { targetYear: 2010, emphasizedKey: "rural", showGap: false },
    { targetYear: 2014, emphasizedKey: "rural", showGap: true  },
    { targetYear: 9999, emphasizedKey: null,    showGap: false },
];

const formatRate = d3.format(".1f");

function parsePopulation(value) {
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function parseRateRange(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (text.startsWith(">")) {
        const parsed = Number(text.slice(1).replace(/[^0-9.]/g, ""));
        return Number.isFinite(parsed) ? parsed + 1 : null;
    }
    if (text.includes("-")) {
        const [low, high] = text.split("-").map((p) => Number(p.trim()));
        if (Number.isFinite(low) && Number.isFinite(high)) return (low + high) / 2;
    }
    const parsed = Number(text.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function buildSeries(rows, fipsToGroup) {
    const withGroups = rows
        .map((r) => ({ ...r, groupKey: fipsToGroup.get(r.fips) }))
        .filter((r) => r.groupKey != null);

    const years = Array.from(new Set(withGroups.map((r) => r.year))).sort(d3.ascending);

    const nested = d3.rollups(
        withGroups,
        (vals) => ({ mean: d3.mean(vals, (v) => v.rateMid), count: vals.length }),
        (r) => r.year,
        (r) => r.groupKey
    );

    const yearLookup = new Map(nested.map(([year, vals]) => [year, new Map(vals)]));

    const series = urBands.map((band) => ({
        ...band,
        values: years.map((year) => {
            const rec = yearLookup.get(year)?.get(band.key);
            return { year, value: rec ? rec.mean : null, count: rec ? rec.count : 0 };
        }),
    }));

    return { series, years };
}

function nearestYear(target) {
    if (!state.years.length) return null;
    const clamped = Math.min(target, state.years[state.years.length - 1]);
    return state.years.reduce((prev, curr) =>
        Math.abs(curr - clamped) < Math.abs(prev - clamped) ? curr : prev
    );
}

function initChart() {
    chartContainer.innerHTML = "";

    // Legend
    legendContainer.innerHTML = urBands
        .map((band) => `<div class="legend-item">
            <span class="legend-swatch" id="swatch-${band.key}" style="background:${band.color}"></span>
            <span>${band.label}</span>
        </div>`)
        .join("");

    const width  = chartContainer.clientWidth || 600;
    const height = Math.min(Math.max(300, Math.round(width * 0.62)), 460);
    const margin = { top: 75, right: 28, bottom: 60, left: 62 };
    const innerW = width  - margin.left - margin.right;
    const innerH = height - margin.top  - margin.bottom;

    chart.margin = margin;

    const svg = d3.select(chartContainer)
        .append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("aria-label", "Line chart showing average drug poisoning mortality by urban/rural status");
    chart.svg = svg;

    svg.append("text")
        .attr("x", width / 2).attr("y", 20)
        .attr("text-anchor", "middle")
        .attr("fill", "#333").attr("font-size", 12).attr("font-weight", "600")
        .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
        .text("Drug Poisoning Mortality Trends by Urban/Rural Status");

    const x = d3.scaleLinear()
        .domain(d3.extent(state.years))
        .range([margin.left, width - margin.right]);
    const yMax = d3.max(state.series, (s) => d3.max(s.values, (v) => v.value));
    const y = d3.scaleLinear()
        .domain([0, Math.ceil(yMax) + 2]).nice()
        .range([height - margin.bottom, margin.top]);
    chart.xScale = x;
    chart.yScale = y;

    svg.append("g")
        .attr("transform", `translate(${margin.left}, 0)`)
        .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickPadding(8))
        .call((g) => g.selectAll("text").attr("fill", "#999").attr("font-size", 10).attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif"))
        .call((g) => g.selectAll("path").remove())
        .call((g) => g.selectAll(".tick line").attr("stroke", "#e8e8e8"));

    svg.append("g")
        .attr("transform", `translate(0, ${height - margin.bottom})`)
        .call(d3.axisBottom(x).tickValues(state.years).tickFormat(d3.format("d")).tickSize(4))
        .call((g) => g.selectAll("text")
            .attr("fill", "#999").attr("font-size", 9.5).attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
            .attr("transform", "rotate(-45)").attr("text-anchor", "end").attr("dy", "0.3em").attr("dx", "-0.4em"))
        .call((g) => g.selectAll("path").attr("stroke", "#e2e2e2"))
        .call((g) => g.selectAll(".tick line").attr("stroke", "#e2e2e2"));

    svg.append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -(margin.top + innerH / 2)).attr("y", 14)
        .attr("text-anchor", "middle").attr("fill", "#aaa").attr("font-size", 10)
        .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
        .text("Average Death Rate (per 100k)");

    svg.append("text")
        .attr("x", margin.left + innerW / 2).attr("y", height - 4)
        .attr("text-anchor", "middle").attr("fill", "#aaa").attr("font-size", 10)
        .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
        .text("Year");

    const line = d3.line()
        .defined((d) => d.value != null)
        .x((d) => x(d.year))
        .y((d) => y(d.value))
        .curve(d3.curveMonotoneX);

    // Annotation lines — drawn before series so they sit underneath
    chart.annotations = ANNOTATIONS.map((ann) => {
        const ax = x(ann.year);
        const g  = svg.append("g").attr("opacity", 0);

        g.append("line")
            .attr("x1", ax).attr("x2", ax)
            .attr("y1", margin.top).attr("y2", height - margin.bottom)
            .attr("stroke", "#d0d0d0")
            .attr("stroke-dasharray", "3 3")
            .attr("stroke-width", 1);

        g.append("text")
            .attr("transform", `translate(${ax + 3}, ${margin.top - 5}) rotate(-45)`)
            .attr("text-anchor", "start")
            .attr("fill", "#aaa")
            .attr("font-size", 8.5)
            .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
            .text(ann.label);

        return { year: ann.year, g };
    });

    const seriesGroup = svg.append("g");

    // Create paths — fully hidden (dashoffset = totalLen)
    chart.paths = {};
    state.series.forEach((s) => {
        const el = seriesGroup.append("path")
            .datum(s.values)
            .attr("fill", "none")
            .attr("stroke", s.color)
            .attr("stroke-width", 2.5)
            .attr("stroke-linecap", "round")
            .attr("d", line);

        const totalLen = el.node().getTotalLength();
        el.attr("stroke-dasharray", totalLen).attr("stroke-dashoffset", totalLen);
        chart.paths[s.key] = { el, totalLen };
    });

    // Create all dots — fully hidden
    chart.dots = {};
    state.series.forEach((s) => {
        chart.dots[s.key] = s.values
            .filter((v) => v.value != null)
            .map((v) => ({
                year: v.year,
                value: v.value,
                el: seriesGroup.append("circle")
                    .attr("cx", x(v.year))
                    .attr("cy", y(v.value))
                    .attr("r", 3.5)
                    .attr("fill", s.color)
                    .attr("stroke", "#fff")
                    .attr("stroke-width", 1.5)
                    .attr("opacity", 0),
            }));
    });

    // Gap bracket group — hidden until needed
    const gapG = svg.append("g").attr("opacity", 0);
    chart.gapG      = gapG;
    chart.gapLine    = gapG.append("line").attr("stroke", "#999").attr("stroke-width", 1);
    chart.gapTickTop = gapG.append("line").attr("stroke", "#999").attr("stroke-width", 1);
    chart.gapTickBot = gapG.append("line").attr("stroke", "#999").attr("stroke-width", 1);
    chart.gapText    = gapG.append("text")
        .attr("fill", "#555").attr("font-size", 11)
        .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif");

    // Focus year label — hidden until first update
    chart.focusLabel = svg.append("text")
        .attr("fill", "#555").attr("font-size", 11).attr("font-weight", "700")
        .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
        .attr("opacity", 0);
}

function updateChart(stepConfig, instant = false) {
    const {
        targetYear    = state.years[state.years.length - 1],
        emphasizedKey = null,
        showGap       = false,
    } = stepConfig;

    const focusYear = nearestYear(targetYear);
    const focusIdx  = state.years.indexOf(focusYear);
    const drawRatio = state.years.length > 1 ? focusIdx / (state.years.length - 1) : 1;
    const dur       = instant ? 0 : DRAW_MS;

    const x = chart.xScale;
    const y = chart.yScale;

    // Paths — transition dashoffset + stroke width (emphasis = thicker, not color change)
    state.series.forEach((s) => {
        const isEmph       = !emphasizedKey || s.key === emphasizedKey;
        const { el, totalLen } = chart.paths[s.key];
        const targetOffset = totalLen * (1 - drawRatio);

        el.attr("stroke", s.color).attr("stroke-width", isEmph ? 2.5 : 1.5);
        el.transition().duration(dur).ease(d3.easeQuadOut).attr("stroke-dashoffset", targetOffset);
    });

    // Dots — fade in/out based on year <= focusYear
    state.series.forEach((s) => {
        const isEmph = !emphasizedKey || s.key === emphasizedKey;

        chart.dots[s.key].forEach((dot) => {
            const shouldShow = dot.year <= focusYear;
            dot.el
                .attr("fill", s.color)
                .attr("r", dot.year === focusYear && isEmph ? 5.5 : 3.5)
                .transition()
                .duration(instant ? 0 : 200)
                .attr("opacity", shouldShow ? 1 : 0);
        });
    });

    // Gap bracket
    if (showGap) {
        const ruralS = state.series.find((s) => s.key === "rural");
        const urbanS = state.series.find((s) => s.key === "urban");
        if (ruralS && urbanS) {
            const rPt = ruralS.values.find((v) => v.year === focusYear);
            const uPt = urbanS.values.find((v) => v.year === focusYear);
            if (rPt?.value != null && uPt?.value != null) {
                const gap  = Math.abs(rPt.value - uPt.value);
                const xPos = x(focusYear) + 16;
                const yTop = y(rPt.value);
                const yBot = y(uPt.value);

                chart.gapLine.attr("x1", xPos).attr("x2", xPos).attr("y1", yTop).attr("y2", yBot);
                chart.gapTickTop.attr("x1", xPos - 4).attr("x2", xPos + 4).attr("y1", yTop).attr("y2", yTop);
                chart.gapTickBot.attr("x1", xPos - 4).attr("x2", xPos + 4).attr("y1", yBot).attr("y2", yBot);
                chart.gapText.attr("x", xPos + 8).attr("y", (yTop + yBot) / 2 + 4).text(`${formatRate(gap)} pt gap`);

                chart.gapG.transition().duration(instant ? 0 : 300).attr("opacity", 1);
            }
        }
    } else {
        chart.gapG.transition().duration(instant ? 0 : 200).attr("opacity", 0);
    }

    // Annotations — fade in as line draws past each event year
    chart.annotations.forEach((ann) => {
        ann.g.transition().duration(instant ? 0 : 400)
            .attr("opacity", focusYear >= ann.year ? 1 : 0);
    });

    // Focus year label
    chart.focusLabel
        .attr("x", x(focusYear) + 6)
        .attr("y", chart.margin.top + 14)
        .text(focusYear)
        .transition().duration(instant ? 0 : 200)
        .attr("opacity", 1);

    if (chartCaption) chartCaption.textContent = `Showing ${focusYear}`;
}

function updateForStep(stepIndex) {
    state.currentStep = stepIndex;
    document.querySelectorAll(".step").forEach((el, i) => {
        el.classList.toggle("is-active", i === stepIndex);
    });
    updateChart(STEP_CONFIGS[Math.min(stepIndex, STEP_CONFIGS.length - 1)]);
}

async function init() {
    const [rawRows, urRows] = await Promise.all([
        d3.csv(dataUrl, (row) => {
            const year       = Number(row.Year);
            const population = parsePopulation(row.Population);
            const rateMid    = parseRateRange(row["Estimated Age-adjusted Death Rate, 16 Categories (in ranges)"]);
            if (!Number.isFinite(year) || population == null || rateMid == null) return null;
            return {
                year, population, rateMid,
                fips:   String(row.FIPS).padStart(5, "0"),
                state:  row.State,
                county: row.County,
            };
        }),
        d3.csv(urbanRuralUrl, (row) => {
            const num = parseInt(row["2023 Code"]);
            if (!num) return null;
            return {
                fips:  String(row.Location).padStart(5, "0"),
                group: num <= 3 ? "urban" : "rural",
            };
        }),
    ]);

    const fipsToGroup = new Map(urRows.filter(Boolean).map((r) => [r.fips, r.group]));

    state.rows   = rawRows.filter(Boolean);
    const built  = buildSeries(state.rows, fipsToGroup);
    state.series = built.series;
    state.years  = built.years;

    initChart();
    updateChart(STEP_CONFIGS[0]);
    document.querySelectorAll(".step")[0]?.classList.add("is-active");

    const scroller = scrollama();
    scroller
        .setup({ step: ".step", offset: 0.55 })
        .onStepEnter(({ index }) => updateForStep(index));

    window.addEventListener("resize", () => {
        scroller.resize();
        initChart();
        updateChart(STEP_CONFIGS[state.currentStep], true);
    });
}

init().catch((err) => {
    console.error(err);
    if (chartContainer) {
        chartContainer.innerHTML = `<p style="padding:2rem;color:#555;font-family:sans-serif;">
            Could not load data. Make sure both CSV files are present and the page is served from a local web server.
        </p>`;
    }
});
