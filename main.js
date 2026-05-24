
const dataUrl = "NCHS_-_Drug_Poisoning_Mortality_by_County__United_States_20260522.csv";

const state = {
    rows: [],
    years: [],
    series: [],
    selectedIndex: 0,
    playTimer: null,
    resizeObserver: null,
};

const chartContainer = document.querySelector("#chart");
const yearSlider = document.querySelector("#year-slider");
const yearLabel = document.querySelector("#year-label");
const playButton = document.querySelector("#play-button");
const gapValue = document.querySelector("#gap-value");
const yearSummary = document.querySelector("#year-summary");
const legendContainer = document.querySelector("#legend");

const populationBands = [
    { key: "smallest", label: "Smallest counties", color: "#0f766e" },
    { key: "lower-mid", label: "Lower-middle counties", color: "#3b82f6" },
    { key: "upper-mid", label: "Upper-middle counties", color: "#f59e0b" },
    { key: "largest", label: "Largest counties", color: "#c2410c" },
];

const formatRate = d3.format(".1f");

function parsePopulation(value) {
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function parseRateRange(value) {
    if (!value) {
        return null;
    }

    const text = String(value).trim();

    if (text.startsWith(">")) {
        const parsed = Number(text.slice(1).replace(/[^0-9.]/g, ""));
        return Number.isFinite(parsed) ? parsed + 1 : null;
    }

    if (text.includes("-")) {
        const [low, high] = text.split("-").map((part) => Number(part.trim()));
        if (Number.isFinite(low) && Number.isFinite(high)) {
            return (low + high) / 2;
        }
    }

    const parsed = Number(text.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function classifyPopulation(population, thresholds) {
    if (population <= thresholds[0]) {
        return populationBands[0];
    }
    if (population <= thresholds[1]) {
        return populationBands[1];
    }
    if (population <= thresholds[2]) {
        return populationBands[2];
    }
    return populationBands[3];
}

function buildSeries(rows) {
    const populations = rows.map((row) => row.population).sort(d3.ascending);
    const thresholds = [
        d3.quantileSorted(populations, 0.25),
        d3.quantileSorted(populations, 0.5),
        d3.quantileSorted(populations, 0.75),
    ];

    const withGroups = rows.map((row) => ({
        ...row,
        group: classifyPopulation(row.population, thresholds),
    }));

    const years = Array.from(new Set(withGroups.map((row) => row.year))).sort(d3.ascending);
    const nested = d3.rollups(
        withGroups,
        (values) => ({
            median: d3.median(values, (value) => value.rateMid),
            mean: d3.mean(values, (value) => value.rateMid),
            count: values.length,
        }),
        (row) => row.year,
        (row) => row.group.key
    );

    const yearLookup = new Map(
        nested.map(([year, values]) => [year, new Map(values)])
    );

    const series = populationBands.map((band) => ({
        ...band,
        values: years.map((year) => {
            const record = yearLookup.get(year)?.get(band.key);
            return {
                year,
                value: record ? record.median : null,
                mean: record ? record.mean : null,
                count: record ? record.count : 0,
            };
        }),
    }));

    return { series, years };
}

function updateText() {
    const selectedYear = state.years[state.selectedIndex];
    const selectedValues = state.series
        .map((series) => ({
            label: series.label,
            color: series.color,
            datum: series.values[state.selectedIndex],
        }))
        .filter((item) => item.datum && item.datum.value != null);

    const smallest = selectedValues[0];
    const largest = selectedValues[selectedValues.length - 1];
    const gap = smallest && largest ? largest.datum.value - smallest.datum.value : null;

    yearLabel.textContent = selectedYear ?? "—";
    gapValue.textContent = gap == null ? "—" : `${formatRate(gap)} points`;

    const firstYear = state.years[0];
    const lastYear = state.years[state.years.length - 1];
    const firstSmall = state.series[0]?.values[0]?.value;
    const firstLarge = state.series[state.series.length - 1]?.values[0]?.value;
    const lastSmall = state.series[0]?.values[state.years.length - 1]?.value;
    const lastLarge = state.series[state.series.length - 1]?.values[state.years.length - 1]?.value;
    const startGap = firstSmall != null && firstLarge != null ? firstLarge - firstSmall : null;
    const endGap = lastSmall != null && lastLarge != null ? lastLarge - lastSmall : null;

    const trendText =
        startGap != null && endGap != null
            ? `Across the full time span, the smallest-vs-largest county gap ${Math.abs(endGap) < Math.abs(startGap) ? "narrows" : "widens"} from ${formatRate(startGap)} in ${firstYear} to ${formatRate(endGap)} in ${lastYear}.`
            : "";

    yearSummary.textContent = selectedValues.length
        ? `In ${selectedYear}, the median midpoint rate was ${formatRate(smallest.datum.value)} in the smallest counties and ${formatRate(largest.datum.value)} in the largest counties. ${trendText}`
        : "No comparable values were available for the selected year.";
}

function renderChart() {
    if (!state.rows.length || !state.years.length) {
        return;
    }

    chartContainer.innerHTML = "";
    legendContainer.innerHTML = "";

    legendContainer.innerHTML = state.series
        .map(
            (series) => `
                <div class="legend-item">
                    <span class="legend-swatch" style="background:${series.color}"></span>
                    <span>${series.label}</span>
                </div>
            `
        )
        .join("");

    const width = chartContainer.clientWidth || 900;
    const height = Math.max(460, Math.round(width * 0.58));
    const margin = { top: 28, right: 28, bottom: 58, left: 72 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3
        .select(chartContainer)
        .append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("role", "img")
        .attr("aria-label", "Line chart showing median estimated drug poisoning mortality by county population group over time");

    const tooltip = d3
        .select(chartContainer)
        .append("div")
        .attr("class", "tooltip")
        .style("opacity", 0);

    const x = d3
        .scaleLinear()
        .domain(d3.extent(state.years))
        .range([margin.left, width - margin.right]);

    const yMax = d3.max(state.series, (series) => d3.max(series.values, (value) => value.value));
    const y = d3
        .scaleLinear()
        .domain([0, yMax * 1.12])
        .nice()
        .range([height - margin.bottom, margin.top]);

    const xAxis = d3
        .axisBottom(x)
        .tickValues(state.years.filter((year, index) => index % 2 === 0 || index === state.years.length - 1))
        .tickFormat(d3.format("d"));

    const yAxis = d3.axisLeft(y).ticks(6).tickSize(-innerWidth).tickPadding(10);

    svg
        .append("g")
        .attr("transform", `translate(0, ${height - margin.bottom})`)
        .call(xAxis)
        .call((group) => group.selectAll("text").attr("fill", "#526174"))
        .call((group) => group.selectAll("path, line").attr("stroke", "#b7c3cf"));

    svg
        .append("g")
        .attr("transform", `translate(${margin.left}, 0)`)
        .call(yAxis)
        .call((group) => group.selectAll("text").attr("fill", "#526174"))
        .call((group) => group.selectAll("path, line").attr("stroke", "#d7e0e8"))
        .call((group) => group.selectAll(".tick line").attr("opacity", 0.45));

    svg
        .append("text")
        .attr("x", margin.left)
        .attr("y", 18)
        .attr("fill", "#526174")
        .attr("font-size", 13)
        .text("Estimated death-rate midpoint by county population group");

    const line = d3
        .line()
        .defined((datum) => datum.value != null)
        .x((datum) => x(datum.year))
        .y((datum) => y(datum.value))
        .curve(d3.curveMonotoneX);

    const seriesGroup = svg.append("g");

    seriesGroup
        .selectAll("path.series-line")
        .data(state.series)
        .join("path")
        .attr("class", "series-line")
        .attr("d", (series) => line(series.values))
        .attr("fill", "none")
        .attr("stroke", (series) => series.color)
        .attr("stroke-width", 3)
        .attr("stroke-linecap", "round")
        .attr("opacity", 0.9);

    seriesGroup
        .selectAll("circle.series-point")
        .data(state.series.flatMap((series) =>
            series.values
                .filter((datum) => datum.value != null)
                .map((datum) => ({ ...datum, label: series.label, color: series.color }))
        ))
        .join("circle")
        .attr("class", "series-point")
        .attr("cx", (datum) => x(datum.year))
        .attr("cy", (datum) => y(datum.value))
        .attr("r", 3.5)
        .attr("fill", (datum) => datum.color)
        .attr("stroke", "white")
        .attr("stroke-width", 1.2)
        .on("mouseenter", (event, datum) => {
            tooltip
                .style("opacity", 1)
                .html(
                    `<strong>${datum.label}</strong>${datum.year}<br>Median midpoint: ${formatRate(datum.value)}<br>Counties: ${datum.count}`
                );
        })
        .on("mousemove", (event) => {
            const [xPos, yPos] = d3.pointer(event, chartContainer);
            tooltip
                .style("left", `${xPos}px`)
                .style("top", `${yPos}px`);
        })
        .on("mouseleave", () => {
            tooltip.style("opacity", 0);
        });

    const selectedYear = state.years[state.selectedIndex];

    svg
        .append("line")
        .attr("x1", x(selectedYear))
        .attr("x2", x(selectedYear))
        .attr("y1", margin.top)
        .attr("y2", height - margin.bottom)
        .attr("stroke", "#8aa0b6")
        .attr("stroke-dasharray", "6 6")
        .attr("stroke-width", 1.4);

    const selectedGroup = seriesGroup
        .selectAll("circle.selected-point")
        .data(state.series.map((series) => ({
            ...series.values[state.selectedIndex],
            label: series.label,
            color: series.color,
        })).filter((datum) => datum.value != null))
        .join("circle")
        .attr("class", "selected-point")
        .attr("cx", (datum) => x(datum.year))
        .attr("cy", (datum) => y(datum.value))
        .attr("r", 7)
        .attr("fill", (datum) => datum.color)
        .attr("fill-opacity", 0.18)
        .attr("stroke", (datum) => datum.color)
        .attr("stroke-width", 2.5);

    svg
        .append("text")
        .attr("x", x(selectedYear) + 8)
        .attr("y", margin.top + 16)
        .attr("fill", "#334155")
        .attr("font-size", 13)
        .attr("font-weight", 700)
        .text(`Selected: ${selectedYear}`);

}

function updateSelectedYear(nextIndex) {
    state.selectedIndex = nextIndex;
    yearSlider.value = String(nextIndex);
    updateText();
    renderChart();
}

function startPlaying() {
    if (state.playTimer) {
        clearInterval(state.playTimer);
    }

    playButton.textContent = "Pause";
    state.playTimer = setInterval(() => {
        const nextIndex = state.selectedIndex >= state.years.length - 1 ? 0 : state.selectedIndex + 1;
        updateSelectedYear(nextIndex);
    }, 1400);
}

function stopPlaying() {
    if (state.playTimer) {
        clearInterval(state.playTimer);
        state.playTimer = null;
    }
    playButton.textContent = "Play";
}

async function init() {
    const rawRows = await d3.csv(dataUrl, (row) => {
        const year = Number(row.Year);
        const population = parsePopulation(row.Population);
        const rateMid = parseRateRange(row["Estimated Age-adjusted Death Rate, 16 Categories (in ranges)"]);

        if (!Number.isFinite(year) || population == null || rateMid == null) {
            return null;
        }

        return {
            year,
            population,
            rateMid,
            state: row.State,
            county: row.County,
        };
    });

    state.rows = rawRows.filter(Boolean);
    const built = buildSeries(state.rows);
    state.series = built.series;
    state.years = built.years;

    yearSlider.min = "0";
    yearSlider.max = String(state.years.length - 1);
    yearSlider.value = "0";
    yearSlider.disabled = false;
    playButton.disabled = false;

    updateText();
    renderChart();

    yearSlider.addEventListener("input", (event) => {
        updateSelectedYear(Number(event.target.value));
    });

    playButton.addEventListener("click", () => {
        if (state.playTimer) {
            stopPlaying();
        } else {
            startPlaying();
        }
    });

    state.resizeObserver = new ResizeObserver(() => {
        renderChart();
    });
    state.resizeObserver.observe(chartContainer);
}

init().catch((error) => {
    console.error(error);
    yearSummary.textContent = "The chart could not load the CSV. Check that the data file path is correct and that the page is being served from a local web server.";
    yearLabel.textContent = "Error";
});
