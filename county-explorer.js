(function () {
    const countyDataUrl = "mortality_rates_by_state.csv";
    const urbanRuralUrl = "county_urban_rural.csv";
    const topoUrl = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";
    const RATE_COL = "Estimated Age-adjusted Death Rate, 16 Categories (in ranges)";

    const countySearchInput = document.querySelector("#county-search");
    const countySearchButton = document.querySelector("#county-search-button");
    const countyResult = document.querySelector("#county-result");
    const suggestionsEl = document.querySelector("#county-suggestions");
    const resetBtn = document.querySelector("#us-map-reset");
    const countyGame = document.querySelector("#county-game");

    let countyRows = [];
    let countyLookup = new Map(); // normalized name -> { fips, displayName }
    let classMap = new Map();     // fips -> 'rural' | 'urban'
    let usTopoJson = null;
    let focusedIndex = -1;

    let gameState = {
        difficulty: "easy",
        score: 0,
        total: 0,
        streak: 0,
        bestStreak: 0,
        currentRound: null,
    };
    let seenCounties = new Set();      // fips the user has viewed in the explorer
    let nationalMediansCache = null;   // year -> { urban, rural } national medians
    // US map rendering state
    let usMapPathFn = null;
    let usMapCountyFeatures = null;
    let mapGroup = null;
    let selectionOverlay = null;
    let mapWidth = 0;
    let mapHeight = 0;

    const toFips5 = (id) => String(id).padStart(5, "0");
    const fmtRate = d3.format(".1f");
    const fmtPop = d3.format(",");

    // --- Parsing ---

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

    function classifyFips(fips) {
        return classMap.get(fips) ?? null;
    }

    function normalize(value) {
        return String(value).toLowerCase().trim();
    }

    // --- Data building ---

    function buildCountyLookup(rows) {
        const grouped = d3.group(rows, (row) => row.fips);
        countyLookup = new Map();
        grouped.forEach((rowsForCounty, fips) => {
            const displayName = rowsForCounty[0].county;
            countyLookup.set(normalize(displayName), { fips, displayName });
        });
    }

    function buildClassMap(urbanRuralRows) {
        classMap = new Map();
        urbanRuralRows.forEach((row) => {
            const code = parseInt(row.code, 10);
            classMap.set(row.fips, code <= 4 ? "urban" : "rural");
        });
    }

    function buildStateAggregateSeries(fips) {
        const statePrefix = fips.slice(0, 2);
        const stateRows = countyRows.filter(
            (r) => r.fips.startsWith(statePrefix) && classMap.has(r.fips)
        );
        const years = Array.from(new Set(stateRows.map((r) => r.year))).sort(d3.ascending);
        const byGroup = d3.rollups(
            stateRows,
            (vals) => d3.median(vals, (r) => r.rateMid),
            (r) => classifyFips(r.fips),
            (r) => r.year
        );
        const lookup = new Map(byGroup.map(([g, yv]) => [g, new Map(yv)]));
        return {
            rural: years.map((y) => ({ year: y, median: lookup.get("rural")?.get(y) ?? null })),
            urban: years.map((y) => ({ year: y, median: lookup.get("urban")?.get(y) ?? null })),
        };
    }

    // --- Autocomplete ---

    function getSuggestions(query) {
        const q = normalize(query);
        if (q.length < 2) return [];
        return Array.from(countyLookup.values())
            .filter(({ displayName }) => normalize(displayName).includes(q))
            .map(({ displayName }) => displayName)
            .slice(0, 8);
    }

    function renderSuggestions(names) {
        if (!names.length) { suggestionsEl.hidden = true; return; }
        suggestionsEl.innerHTML = names.map((n) => `<li role="option">${n}</li>`).join("");
        suggestionsEl.hidden = false;
        focusedIndex = -1;
    }

    function hideSuggestions() {
        suggestionsEl.hidden = true;
        focusedIndex = -1;
    }

    function selectSuggestion(name) {
        countySearchInput.value = name;
        hideSuggestions();
        handleSearch();
    }

    function moveFocus(delta) {
        const items = suggestionsEl.querySelectorAll("li");
        if (!items.length) return;
        focusedIndex = Math.max(0, Math.min(focusedIndex + delta, items.length - 1));
        items.forEach((el, i) => el.classList.toggle("is-focused", i === focusedIndex));
    }

    countySearchInput.addEventListener("input", () => {
        renderSuggestions(getSuggestions(countySearchInput.value));
    });

    countySearchInput.addEventListener("keydown", (event) => {
        const items = suggestionsEl.querySelectorAll("li");
        if (!suggestionsEl.hidden && items.length) {
            if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); return; }
            if (event.key === "ArrowUp")   { event.preventDefault(); moveFocus(-1); return; }
            if (event.key === "Escape")    { hideSuggestions(); return; }
            if (event.key === "Enter" && focusedIndex >= 0) {
                selectSuggestion(items[focusedIndex].textContent); return;
            }
        }
        if (event.key === "Enter") handleSearch();
    });

    suggestionsEl.addEventListener("mousedown", (event) => {
        const li = event.target.closest("li");
        if (li) { event.preventDefault(); selectSuggestion(li.textContent); }
    });

    document.addEventListener("click", (event) => {
        if (!countySearchInput.contains(event.target) && !suggestionsEl.contains(event.target)) {
            hideSuggestions();
        }
    });

    // --- Search / selection ---

    function findFips(searchValue) {
        const q = normalize(searchValue);
        if (!q) return null;
        if (countyLookup.has(q)) return countyLookup.get(q).fips;
        const matches = Array.from(countyLookup.values()).filter(({ displayName }) =>
            normalize(displayName).includes(q)
        );
        if (matches.length === 1) return matches[0].fips;
        if (matches.length > 1) {
            countyResult.innerHTML = `
                <p><strong>Multiple counties matched.</strong> Please type the full county name and state.</p>
                <ul>${matches.slice(0, 8).map(({ displayName }) => `<li>${displayName}</li>`).join("")}</ul>
            `;
            return null;
        }
        return null;
    }

    function handleSearch() {
        hideSuggestions();
        const fips = findFips(countySearchInput.value);
        if (!fips) {
            if (!countyResult.innerHTML.includes("Multiple counties")) {
                countyResult.innerHTML = `<p>County not found. Try a full name like <strong>King County, WA</strong>.</p>`;
            }
            return;
        }
        selectCounty(fips);
    }

    function selectCounty(fips) {
        seenCounties.add(fips);
        renderCountyResult(fips);
        zoomToState(fips);
        highlightUSMapCounty(fips);
    }

    // --- Render result (right panel) ---

    function renderCountyResult(fips) {
        const rows = countyRows
            .filter((row) => row.fips === fips)
            .sort((a, b) => d3.ascending(a.year, b.year));

        if (!rows.length) {
            countyResult.innerHTML = `<p>No data found for this county.</p>`;
            return;
        }

        const firstRow = rows[0];
        const lastRow = rows[rows.length - 1];
        const totalChange = lastRow.rateMid - firstRow.rateMid;
        const group = classifyFips(fips);
        const groupLabel = group === "urban" ? "Urban county"
                         : group === "rural" ? "Rural county"
                         : "Unclassified";

        const pctChange = firstRow.rateMid > 0
            ? Math.round((totalChange / firstRow.rateMid) * 100)
            : null;
        const directionWord = totalChange > 0 ? "increase" : totalChange < 0 ? "decrease" : null;
        const changeSummary = directionWord && pctChange !== null
            ? `${fmtRate(firstRow.rateMid)} → ${fmtRate(lastRow.rateMid)} per 100k &mdash; a ${Math.abs(pctChange)}% ${directionWord}`
            : `${fmtRate(firstRow.rateMid)} → ${fmtRate(lastRow.rateMid)} per 100k`;

        countyResult.innerHTML = `
            <h2>${lastRow.county}
                <span class="county-group-badge county-group-${group}">${groupLabel}</span>
            </h2>
            <div class="county-stat-grid">
                <div class="county-stat">
                    <span>Latest year</span>
                    <strong>${lastRow.year}</strong>
                </div>
                <div class="county-stat">
                    <span>Population</span>
                    <strong>${fmtPop(lastRow.population)}</strong>
                </div>
                <div class="county-stat">
                    <span>Rate (${lastRow.year})</span>
                    <strong>${fmtRate(lastRow.rateMid)}</strong>
                </div>
            </div>
            <p>From ${firstRow.year} to ${lastRow.year}: <strong>${changeSummary}</strong>.</p>
            <div id="county-trend-chart" class="county-chart-container"></div>
        `;

        const { rural: stateRural, urban: stateUrban } = buildStateAggregateSeries(fips);
        renderCountyTrendChart(rows, lastRow.county, group, stateRural, stateUrban);
    }

    // --- Full US map ---

    function renderUSMap() {
        const container = document.getElementById("us-map-canvas");
        if (!container || !usTopoJson) return;

        container.innerHTML = "";

        mapWidth  = container.clientWidth  || 560;
        mapHeight = Math.round(mapWidth * 0.62);

        usMapCountyFeatures = topojson.feature(usTopoJson, usTopoJson.objects.counties).features;

        const projection = d3.geoAlbersUsa().fitSize(
            [mapWidth, mapHeight],
            topojson.feature(usTopoJson, usTopoJson.objects.states)
        );
        usMapPathFn = d3.geoPath().projection(projection);

        const svg = d3.select(container)
            .append("svg")
            .attr("viewBox", `0 0 ${mapWidth} ${mapHeight}`)
            .attr("width", "100%");

        // Single group — we transform this for zoom
        mapGroup = svg.append("g");

        const tooltip = d3.select(container)
            .append("div")
            .attr("class", "tooltip us-map-tooltip")
            .style("opacity", 0);

        mapGroup.selectAll("path.us-county")
            .data(usMapCountyFeatures)
            .join("path")
            .attr("class", "us-county")
            .attr("d", usMapPathFn)
            .attr("fill", (d) => {
                const g = classifyFips(toFips5(d.id));
                return g === "urban" ? "rgba(37,99,235,0.13)"
                     : g === "rural" ? "rgba(234,88,12,0.10)"
                     : "var(--bg-alt)";
            })
            .attr("stroke", "var(--panel-border)")
            .attr("stroke-width", 0.3)
            .attr("vector-effect", "non-scaling-stroke")
            .style("cursor", "pointer")
            .on("mouseenter", (event, d) => {
                d3.select(event.currentTarget).attr("fill-opacity", 0.45);
                const entry = Array.from(countyLookup.values()).find((e) => e.fips === toFips5(d.id));
                if (entry) tooltip.style("opacity", 1).text(entry.displayName);
            })
            .on("mousemove", (event) => {
                const [px, py] = d3.pointer(event, container);
                tooltip.style("left", `${px + 14}px`).style("top", `${py - 10}px`);
            })
            .on("mouseleave", (event) => {
                d3.select(event.currentTarget).attr("fill-opacity", 1);
                tooltip.style("opacity", 0);
            })
            .on("click", (event, d) => {
                const fips = toFips5(d.id);
                const entry = Array.from(countyLookup.values()).find((e) => e.fips === fips);
                if (!entry) return;
                tooltip.style("opacity", 0);
                countySearchInput.value = entry.displayName;
                selectCounty(fips);
            });

        // State borders (non-interactive, on top of counties)
        mapGroup.append("path")
            .attr("class", "state-borders")
            .datum(topojson.mesh(usTopoJson, usTopoJson.objects.states, (a, b) => a !== b))
            .attr("fill", "none")
            .attr("stroke", "var(--muted)")
            .attr("stroke-width", 0.7)
            .attr("vector-effect", "non-scaling-stroke")
            .attr("pointer-events", "none")
            .attr("d", usMapPathFn);

        // Selection overlay drawn on top of everything
        selectionOverlay = mapGroup.append("g").attr("pointer-events", "none");
    }

    function zoomToState(fips) {
        if (!mapGroup || !usMapPathFn || !usMapCountyFeatures) return;

        const stateFipsNum = parseInt(fips.slice(0, 2), 10);
        const stateFeatures = usMapCountyFeatures.filter(
            (f) => Math.floor(parseInt(toFips5(f.id), 10) / 1000) === stateFipsNum
        );
        if (!stateFeatures.length) return;

        const [[x0, y0], [x1, y1]] = usMapPathFn.bounds(
            { type: "FeatureCollection", features: stateFeatures }
        );
        if (!isFinite(x0) || !isFinite(y1)) return;

        const scale = 0.88 * Math.min(
            mapWidth  / (x1 - x0),
            mapHeight / (y1 - y0)
        );
        const tx = mapWidth  / 2 - scale * ((x0 + x1) / 2);
        const ty = mapHeight / 2 - scale * ((y0 + y1) / 2);

        mapGroup.transition()
            .duration(700)
            .ease(d3.easeCubicInOut)
            .attr("transform", `translate(${tx},${ty}) scale(${scale})`);

        if (resetBtn) resetBtn.hidden = false;
    }

    function resetUSMap() {
        if (!mapGroup) return;
        mapGroup.transition()
            .duration(500)
            .ease(d3.easeCubicInOut)
            .attr("transform", "translate(0,0) scale(1)");
        if (selectionOverlay) selectionOverlay.selectAll("*").remove();
        if (resetBtn) resetBtn.hidden = true;
    }

    function highlightUSMapCounty(fips) {
        if (!selectionOverlay || !usMapPathFn || !usMapCountyFeatures) return;
        selectionOverlay.selectAll("*").remove();

        const feature = usMapCountyFeatures.find((f) => toFips5(f.id) === fips);
        if (!feature) return;

        const color = classifyFips(fips) === "urban" ? "var(--accent-2)" : "var(--accent-1)";

        selectionOverlay.append("path")
            .datum(feature)
            .attr("fill", color)
            .attr("fill-opacity", 0.75)
            .attr("stroke", color)
            .attr("stroke-width", 1.5)
            .attr("vector-effect", "non-scaling-stroke")
            .attr("d", usMapPathFn);
    }

    if (resetBtn) {
        resetBtn.addEventListener("click", resetUSMap);
    }

    // --- Trend chart ---

    function renderCountyTrendChart(rows, countyName, group, ruralSeries, urbanSeries) {
        const chartEl = document.getElementById("county-trend-chart");
        if (!chartEl) return;
        chartEl.innerHTML = "";

        const width  = chartEl.clientWidth || 480;
        const height = 340;
        const margin = { top: 28, right: 20, bottom: 44, left: 56 };

        const allValues = [
            ...ruralSeries.map((d) => d.median),
            ...urbanSeries.map((d) => d.median),
            ...rows.map((d) => d.rateMid),
        ].filter((v) => v != null);

        const years = Array.from(new Set([
            ...ruralSeries.map((d) => d.year),
            ...urbanSeries.map((d) => d.year),
        ])).sort(d3.ascending);

        const x = d3.scaleLinear()
            .domain(d3.extent(years))
            .range([margin.left, width - margin.right]);

        const y = d3.scaleLinear()
            .domain([0, d3.max(allValues) * 1.15])
            .nice()
            .range([height - margin.bottom, margin.top]);

        const svg = d3.select(chartEl)
            .append("svg")
            .attr("viewBox", `0 0 ${width} ${height}`)
            .attr("width", "100%");

        svg.append("g")
            .attr("transform", `translate(0,${height - margin.bottom})`)
            .call(d3.axisBottom(x).tickFormat(d3.format("d")).tickValues(years.filter((_, i) => i % 2 === 0)))
            .call((g) => g.selectAll("text").attr("fill", "var(--chart-text)"))
            .call((g) => g.selectAll("path, line").attr("stroke", "var(--panel-border)"));

        svg.append("g")
            .attr("transform", `translate(${margin.left},0)`)
            .call(d3.axisLeft(y).ticks(5).tickSize(-(width - margin.left - margin.right)).tickPadding(8))
            .call((g) => g.selectAll("text").attr("fill", "var(--chart-text)"))
            .call((g) => g.selectAll("path").remove())
            .call((g) => g.selectAll(".tick line").attr("stroke", "var(--chart-grid)").attr("opacity", 0.6));

        svg.append("text")
            .attr("x", margin.left).attr("y", 16)
            .attr("fill", "var(--chart-text)").attr("font-size", 11)
            .text("Estimated age-adjusted rate per 100k");

        const makeLine = (acc) => d3.line()
            .defined((d) => acc(d) != null)
            .x((d) => x(d.year))
            .y((d) => y(acc(d)))
            .curve(d3.curveMonotoneX);

        // State rural median (orange dashed)
        svg.append("path").datum(ruralSeries)
            .attr("fill", "none").attr("stroke", "var(--accent-1)")
            .attr("stroke-width", 1.8).attr("stroke-dasharray", "5 3").attr("opacity", 0.65)
            .attr("d", makeLine((d) => d.median));

        // State urban median (blue dashed)
        svg.append("path").datum(urbanSeries)
            .attr("fill", "none").attr("stroke", "var(--accent-2)")
            .attr("stroke-width", 1.8).attr("stroke-dasharray", "5 3").attr("opacity", 0.65)
            .attr("d", makeLine((d) => d.median));

        const countyColor = group === "urban" ? "var(--accent-2)" : "var(--accent-1)";

        // County line (solid, thicker)
        svg.append("path").datum(rows)
            .attr("fill", "none").attr("stroke", countyColor)
            .attr("stroke-width", 2.8).attr("stroke-linecap", "round")
            .attr("d", makeLine((d) => d.rateMid));

        // Tooltip + dots
        const tooltip = d3.select(chartEl).append("div")
            .attr("class", "tooltip").style("opacity", 0);

        svg.selectAll("circle.trend-point")
            .data(rows).join("circle").attr("class", "trend-point")
            .attr("cx", (d) => x(d.year)).attr("cy", (d) => y(d.rateMid))
            .attr("r", 4).attr("fill", countyColor)
            .attr("stroke", "var(--panel)").attr("stroke-width", 1.5)
            .on("mouseenter", (event, d) => {
                tooltip.style("opacity", 1)
                    .html(`<strong>${d.year}</strong>${fmtRate(d.rateMid)} per 100k`);
            })
            .on("mousemove", (event) => {
                const [px, py] = d3.pointer(event, chartEl);
                tooltip.style("left", `${px}px`).style("top", `${py}px`);
            })
            .on("mouseleave", () => tooltip.style("opacity", 0));

        // Legend
        const legend = svg.append("g")
            .attr("transform", `translate(${margin.left + 4},${margin.top + 4})`);

        [
            { label: "State rural median", color: "var(--accent-1)", dashed: true },
            { label: "State urban median", color: "var(--accent-2)", dashed: true },
            { label: countyName.split(",")[0], color: countyColor, dashed: false },
        ].forEach((item, i) => {
            const g = legend.append("g").attr("transform", `translate(0,${i * 18})`);
            g.append("line")
                .attr("x1", 0).attr("x2", 20).attr("y1", 6).attr("y2", 6)
                .attr("stroke", item.color)
                .attr("stroke-width", item.dashed ? 1.5 : 2.5)
                .attr("stroke-dasharray", item.dashed ? "4 2" : "none");
            g.append("text").attr("x", 26).attr("y", 10)
                .attr("fill", "var(--chart-text)").attr("font-size", 10)
                .text(item.label);
        });
    }

    // --- Multiple Choice Game ---
    //
    // Questions only ever use values the user has already seen on this page:
    //   Easy   -> national urban-vs-rural median (the scrollytelling line chart)
    //   Medium -> the 2015 border spotlight figures (+ a county the user explored)
    //   Hard   -> counties the user actually looked up in the explorer
    // Rates get closer together as difficulty rises.

    const BORDER_YEAR = 2015;
    const BORDER_FEATURED = [
        { id: "pima", label: "Pima County, AZ", rate: 31.0 },
        { id: "brewster", label: "Brewster County, TX", rate: 21.1 },
        { id: "natl", label: "U.S. national median", rate: 15.1 },
    ];

    function getRandomItem(items) {
        return items[Math.floor(Math.random() * items.length)];
    }

    // Streak indicator: one 🔥 per consecutive correct answer.
    const MAX_STREAK_FLAMES = 12;
    function streakHtml() {
        const streak = gameState.streak;
        if (!streak) {
            return `<span class="game-streak-empty">No streak yet — answer correctly to light a 🔥</span>`;
        }
        const flames = "🔥".repeat(Math.min(streak, MAX_STREAK_FLAMES));
        const overflow = streak > MAX_STREAK_FLAMES ? `+${streak - MAX_STREAK_FLAMES} ` : "";
        return `
            <span class="game-streak-flames" aria-hidden="true">${flames}</span>
            <span class="game-streak-count">${overflow}${streak} in a row</span>
        `;
    }

    function updateStreakDisplay() {
        const el = countyGame.querySelector(".game-streak");
        if (el) el.innerHTML = streakHtml();
    }

    function scoreText() {
        const best = gameState.bestStreak > 0 ? ` · Best streak: ${gameState.bestStreak}` : "";
        return `Score: ${gameState.score} / ${gameState.total}${best}`;
    }

    // National urban/rural medians per year — mirrors the scrollytelling chart.
    function computeNationalMedians() {
        if (nationalMediansCache) return nationalMediansCache;
        const valid = countyRows.filter((r) => r.rateMid != null && classMap.has(r.fips));
        const byYear = d3.rollups(
            valid,
            (vals) => ({
                urban: d3.median(vals.filter((r) => classifyFips(r.fips) === "urban"), (r) => r.rateMid),
                rural: d3.median(vals.filter((r) => classifyFips(r.fips) === "rural"), (r) => r.rateMid),
            }),
            (r) => r.year
        );
        nationalMediansCache = new Map(byYear);
        return nationalMediansCache;
    }

    function countyDisplayName(fips) {
        for (const entry of countyLookup.values()) {
            if (entry.fips === fips) return entry.displayName;
        }
        return fips;
    }

    function countyRateAt(fips, year) {
        const row = countyRows.find((r) => r.fips === fips && r.year === year);
        return row ? row.rateMid : null;
    }

    // Easy: national urban vs rural median, favoring years with the widest gap.
    function buildEasyRound() {
        const medians = computeNationalMedians();
        const years = Array.from(medians.entries())
            .filter(([, m]) => m.urban != null && m.rural != null)
            .map(([year, m]) => ({ year, m, gap: Math.abs(m.urban - m.rural) }));
        if (!years.length) return null;

        years.sort((a, b) => d3.descending(a.gap, b.gap));
        const widePool = years.slice(0, Math.max(1, Math.ceil(years.length / 2)));
        const pick = getRandomItem(widePool);

        return {
            context: `National Trend · ${pick.year}`,
            question: `In ${pick.year}, which type of county had the higher median drug mortality rate?`,
            options: [
                { id: "urban", label: "Urban counties", rate: pick.m.urban, detail: `${fmtRate(pick.m.urban)} per 100k (median)` },
                { id: "rural", label: "Rural counties", rate: pick.m.rural, detail: `${fmtRate(pick.m.rural)} per 100k (median)` },
            ],
        };
    }

    // Medium: the 2015 border spotlight, optionally joined by a county the user explored.
    function buildMediumRound() {
        const options = BORDER_FEATURED.map((o) => ({ ...o, detail: `${fmtRate(o.rate)} per 100k` }));
        const usedLabels = new Set(options.map((o) => o.label));

        const exploredExtras = Array.from(seenCounties)
            .map((fips) => ({ fips, label: countyDisplayName(fips), rate: countyRateAt(fips, BORDER_YEAR) }))
            .filter((d) => d.rate != null && !usedLabels.has(d.label)
                && options.every((o) => Math.abs(o.rate - d.rate) >= 2));

        if (exploredExtras.length) {
            const extra = getRandomItem(exploredExtras);
            options.push({ id: extra.fips, label: extra.label, rate: extra.rate, detail: `${fmtRate(extra.rate)} per 100k` });
        }

        return {
            context: `Border Spotlight · ${BORDER_YEAR}`,
            question: `Which had the highest drug mortality rate in ${BORDER_YEAR}?`,
            options,
        };
    }

    // Hard: four counties from a random year whose rates sit in the tightest
    // cluster (closest call), with a strictly unique highest so there's one answer.
    function buildHardRound() {
        const years = Array.from(new Set(countyRows.map((r) => r.year)));

        for (const year of d3.shuffle(years.slice())) {
            const uniq = Array.from(
                d3.rollup(
                    countyRows.filter((r) => r.year === year && r.rateMid != null),
                    (v) => v[0],
                    (r) => r.fips
                ).values()
            ).sort((a, b) => d3.ascending(a.rateMid, b.rateMid));

            if (uniq.length < 4) continue;

            // Scan consecutive windows of four (closest rates); keep the tightest
            // window whose top value is strictly greater than the runner-up.
            let best = null;
            for (let i = 0; i + 4 <= uniq.length; i++) {
                const window = uniq.slice(i, i + 4);
                if (window[3].rateMid <= window[2].rateMid) continue;
                const spread = window[3].rateMid - window[0].rateMid;
                if (!best || spread < best.spread) best = { window, spread };
            }
            if (!best) continue;

            return {
                context: `Toughest Call · ${year}`,
                question: `Which county had the highest drug mortality rate in ${year}?`,
                options: best.window.map((r) => ({
                    id: r.fips,
                    label: r.county,
                    rate: r.rateMid,
                    detail: `${fmtRate(r.rateMid)} per 100k`,
                })),
            };
        }

        return null;
    }

    function buildRound(difficulty) {
        if (difficulty === "medium") return buildMediumRound();
        if (difficulty === "hard") return buildHardRound();
        return buildEasyRound();
    }

    function startCountyGameRound() {
        if (!countyGame || !countyRows.length) return;

        const round = buildRound(gameState.difficulty);

        if (!round) {
            countyGame.innerHTML = `<div class="game-empty"><p>Not enough data to start the game.</p></div>`;
            return;
        }

        gameState.currentRound = round;
        const display = d3.shuffle(round.options.slice());

        countyGame.innerHTML = `
            <p class="game-year">${round.context}</p>
            <h3 class="game-question">${round.question}</h3>

            <div class="game-options">
                ${display.map((o) => `
                    <button class="game-option" type="button" data-id="${o.id}">
                        ${o.label}
                    </button>
                `).join("")}
            </div>

            <div id="game-feedback" class="game-feedback" aria-live="polite">
                Pick an option to reveal the answer.
            </div>

            <p class="game-streak" aria-live="polite">${streakHtml()}</p>

            <p class="game-score">${scoreText()}</p>
        `;

        countyGame.querySelectorAll(".game-option").forEach((button) => {
            button.addEventListener("click", () => checkCountyGameAnswer(button.dataset.id));
        });
    }

    function checkCountyGameAnswer(selectedId) {
        const round = gameState.currentRound;
        if (!round) return;

        const sorted = round.options.slice().sort((a, b) => d3.descending(a.rate, b.rate));
        const correctId = sorted[0].id;
        const isCorrect = selectedId === correctId;

        gameState.total += 1;
        const brokenStreak = !isCorrect && gameState.streak > 0 ? gameState.streak : 0;
        if (isCorrect) {
            gameState.score += 1;
            gameState.streak += 1;
            gameState.bestStreak = Math.max(gameState.bestStreak, gameState.streak);
        } else {
            gameState.streak = 0;
        }

        countyGame.querySelectorAll(".game-option").forEach((button) => {
            button.disabled = true;
            if (button.dataset.id === correctId) button.classList.add("is-correct");
            else if (button.dataset.id === selectedId) button.classList.add("is-wrong");
        });

        const streakNote = isCorrect
            ? (gameState.streak >= 2 ? ` 🔥 ${gameState.streak} in a row!` : "")
            : (brokenStreak >= 2 ? ` Streak of ${brokenStreak} broken.` : "");

        const feedback = countyGame.querySelector("#game-feedback");
        feedback.innerHTML = `
            <p>
                <strong>${isCorrect ? "Correct!" : "Not quite."}</strong>
                ${sorted[0].label} had the highest rate.${streakNote}
            </p>

            <ul class="game-rates-list">
                ${sorted.map((o) => `
                    <li><strong>${o.label}:</strong> ${o.detail}</li>
                `).join("")}
            </ul>

            <button id="game-next-question" class="game-next-button" type="button">
                Next question
            </button>
        `;

        updateStreakDisplay();

        const score = countyGame.querySelector(".game-score");
        if (score) score.textContent = scoreText();

        countyGame.querySelector("#game-next-question").addEventListener("click", startCountyGameRound);
    }

    // --- Init ---

    async function initCountyExplorer() {
        countyResult.innerHTML = `<p class="county-placeholder">Click a county on the map or search by name to view its drug mortality data.</p>`;

        const [csvResult, urResult, topoResult] = await Promise.allSettled([
            d3.csv(countyDataUrl, (row) => {
                const year = Number(row.Year);
                const population = parsePopulation(row.Population);
                const rateMid = parseRateRange(row[RATE_COL]);
                if (!Number.isFinite(year) || population == null || rateMid == null || !row.County || !row.FIPS) return null;
                return {
                    year, population, rateMid,
                    county: row.County,
                    fips: String(row.FIPS).trim().padStart(5, "0"),
                };
            }),
            d3.csv(urbanRuralUrl, (row) => ({
                fips: String(row.Location).trim().padStart(5, "0"),
                code: row["2023 Code"],
            })),
            d3.json(topoUrl),
        ]);

        if (csvResult.status === "rejected") {
            countyResult.innerHTML = `<p>Could not load county data. Check that the CSV is present and the page is served from a local web server.</p>`;
            return;
        }

        countyRows = csvResult.value.filter(Boolean);
        buildCountyLookup(countyRows);

        if (urResult.status === "fulfilled") buildClassMap(urResult.value);
        if (topoResult.status === "fulfilled") {
            usTopoJson = topoResult.value;
            renderUSMap();
        }
        startCountyGameRound();
    }

    countySearchButton.addEventListener("click", handleSearch);

    document.querySelectorAll(".game-diff-btn").forEach((button) => {
        button.addEventListener("click", () => {
            if (button.dataset.difficulty === gameState.difficulty) return;
            gameState.difficulty = button.dataset.difficulty;
            document.querySelectorAll(".game-diff-btn").forEach((b) => {
                const active = b.dataset.difficulty === gameState.difficulty;
                b.classList.toggle("is-active", active);
                b.setAttribute("aria-pressed", active ? "true" : "false");
            });
            // Score and streak aren't comparable across difficulties, so reset on switch.
            gameState.score = 0;
            gameState.total = 0;
            gameState.streak = 0;
            gameState.bestStreak = 0;
            startCountyGameRound();
        });
    });

    initCountyExplorer().catch((error) => {
        console.error(error);
        countyResult.innerHTML = `<p>Could not load county data.</p>`;
    });
})();
