const dataUrl = "../mortality_rates_by_state.csv";

const RATE_COL = "Estimated Age-adjusted Death Rate, 16 Categories (in ranges)";

const countySearchInput = document.querySelector("#county-search");
const countySearchButton = document.querySelector("#county-search-button");
const countyResult = document.querySelector("#county-result");

let countyRows = [];
let countyLookup = new Map();

const formatRate = d3.format(".1f");
const formatPopulation = d3.format(",");

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

function normalizeText(value) {
    return String(value).toLowerCase().trim();
}

function showMessage(message) {
    countyResult.innerHTML = `<p>${message}</p>`;
}

function buildCountyLookup(rows) {
    const grouped = d3.group(rows, (row) => row.fips);

    countyLookup = new Map();

    grouped.forEach((rowsForCounty, fips) => {
        const firstRow = rowsForCounty[0];
        countyLookup.set(normalizeText(firstRow.county), fips);
    });
}

function findCounty(searchValue) {
    const cleanedSearch = normalizeText(searchValue);

    if (!cleanedSearch) {
        return null;
    }

    if (countyLookup.has(cleanedSearch)) {
        return countyLookup.get(cleanedSearch);
    }

    const matches = Array.from(countyLookup.entries())
        .filter(([countyName]) => countyName.includes(cleanedSearch));

    if (matches.length === 1) {
        return matches[0][1];
    }

    if (matches.length > 1) {
        countyResult.innerHTML = `
            <p><strong>Multiple counties matched your search.</strong></p>
            <p>Please type the full county name and state.</p>
            <ul>
                ${matches.slice(0, 8).map(([countyName]) => `<li>${countyName}</li>`).join("")}
            </ul>
        `;

        return null;
    }

    return null;
}

function renderCountyResult(fips) {
    const rows = countyRows
        .filter((row) => row.fips === fips)
        .sort((a, b) => d3.ascending(a.year, b.year));

    if (!rows.length) {
        showMessage("No data found for this county.");
        return;
    }

    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    const totalChange = lastRow.rateMid - firstRow.rateMid;

    const directionText =
        totalChange > 0
            ? `increased by ${formatRate(totalChange)} deaths per 100k`
            : totalChange < 0
                ? `decreased by ${formatRate(Math.abs(totalChange))} deaths per 100k`
                : "stayed about the same";

    const tableRows = rows
        .map((row) => `
            <tr>
                <td>${row.year}</td>
                <td>${formatRate(row.rateMid)}</td>
                <td>${formatPopulation(row.population)}</td>
            </tr>
        `)
        .join("");

    countyResult.innerHTML = `
        <h2>${lastRow.county}</h2>

        <div class="county-stat-grid">
            <div class="county-stat">
                <span>Latest year</span>
                <strong>${lastRow.year}</strong>
            </div>

            <div class="county-stat">
                <span>Population</span>
                <strong>${formatPopulation(lastRow.population)}</strong>
            </div>

            <div class="county-stat">
                <span>Estimated rate</span>
                <strong>${formatRate(lastRow.rateMid)}</strong>
            </div>
        </div>

        <p>
            In ${lastRow.year}, ${lastRow.county} had an estimated age-adjusted drug mortality rate of
            <strong>${formatRate(lastRow.rateMid)} deaths per 100k people</strong>.
        </p>

        <p>
            From ${firstRow.year} to ${lastRow.year}, the county's estimated rate ${directionText}.
        </p>

        <table class="county-table">
            <thead>
                <tr>
                    <th>Year</th>
                    <th>Estimated rate</th>
                    <th>Population</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
        </table>
    `;
}

function handleSearch() {
    const fips = findCounty(countySearchInput.value);

    if (!fips) {
        if (!countyResult.innerHTML.includes("Multiple counties")) {
            showMessage("County not found. Try a full name like San Diego County, CA.");
        }

        return;
    }

    renderCountyResult(fips);
}

async function initCountyExplorer() {
    showMessage("Loading county data...");

    const rawRows = await d3.csv(dataUrl, (row) => {
        const year = Number(row.Year);
        const population = parsePopulation(row.Population);
        const rateMid = parseRateRange(row[RATE_COL]);

        if (
            !Number.isFinite(year) ||
            population == null ||
            rateMid == null ||
            !row.County ||
            !row.FIPS
        ) {
            return null;
        }

        return {
            year,
            population,
            rateMid,
            county: row.County,
            fips: String(row.FIPS).trim().padStart(5, "0"),
        };
    });

    countyRows = rawRows.filter(Boolean);

    buildCountyLookup(countyRows);

    showMessage("Search for a county to view its data.");
}

countySearchButton.addEventListener("click", handleSearch);

countySearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        handleSearch();
    }
});

initCountyExplorer().catch((error) => {
    console.error(error);
    showMessage("Could not load the county data. Check the CSV file name and file path.");
});


///////
function renderCountyTrendChart(rows) {
    const chart = d3.select("#county-trend-chart");

    if (chart.empty()) {
        return;
    }

    chart.html("");

    const width = chart.node().clientWidth || 700;
    const height = 300;
    const margin = { top: 24, right: 24, bottom: 44, left: 58 };

    const svg = chart
        .append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("role", "img")
        .attr("aria-label", "Line chart showing estimated drug mortality rate over time");

    const x = d3
        .scaleLinear()
        .domain(d3.extent(rows, (d) => d.year))
        .range([margin.left, width - margin.right]);

    const yMax = d3.max(rows, (d) => d.rateMid);

    const y = d3
        .scaleLinear()
        .domain([0, yMax * 1.15])
        .nice()
        .range([height - margin.bottom, margin.top]);

    const xAxis = d3
        .axisBottom(x)
        .tickFormat(d3.format("d"))
        .tickValues(rows.map((d) => d.year).filter((year, index) => index % 2 === 0));

    const yAxis = d3
        .axisLeft(y)
        .ticks(5)
        .tickSize(-(width - margin.left - margin.right))
        .tickPadding(8);

    svg
        .append("g")
        .attr("transform", `translate(0, ${height - margin.bottom})`)
        .call(xAxis)
        .call((g) => g.selectAll("text").attr("fill", "var(--chart-text)"))
        .call((g) => g.selectAll("path, line").attr("stroke", "var(--panel-border)"));

    svg
        .append("g")
        .attr("transform", `translate(${margin.left}, 0)`)
        .call(yAxis)
        .call((g) => g.selectAll("text").attr("fill", "var(--chart-text)"))
        .call((g) => g.selectAll("path").remove())
        .call((g) => g.selectAll(".tick line").attr("stroke", "var(--chart-grid)").attr("opacity", 0.6));

    const line = d3
        .line()
        .x((d) => x(d.year))
        .y((d) => y(d.rateMid))
        .curve(d3.curveMonotoneX);

    svg
        .append("path")
        .datum(rows)
        .attr("fill", "none")
        .attr("stroke", "var(--accent-2)")
        .attr("stroke-width", 3)
        .attr("stroke-linecap", "round")
        .attr("d", line);

    svg
        .selectAll("circle")
        .data(rows)
        .join("circle")
        .attr("cx", (d) => x(d.year))
        .attr("cy", (d) => y(d.rateMid))
        .attr("r", 4)
        .attr("fill", "var(--accent-2)")
        .attr("stroke", "var(--panel-bg)")
        .attr("stroke-width", 1.5);

    svg
        .append("text")
        .attr("x", margin.left)
        .attr("y", 16)
        .attr("fill", "var(--chart-text)")
        .attr("font-size", 12)
        .text("Estimated age-adjusted drug mortality rate per 100k");
}