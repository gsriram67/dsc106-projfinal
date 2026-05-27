(function () {
    const countyDataUrl = "mortality_rates_by_state.csv";
    const RATE_COL = "Estimated Age-adjusted Death Rate, 16 Categories (in ranges)";

    const countySearchInput = document.querySelector("#county-search");
    const countySearchButton = document.querySelector("#county-search-button");
    const countyResult = document.querySelector("#county-result");
    const suggestionsEl = document.querySelector("#county-suggestions");

    let countyRows = [];
    // Maps normalized name -> { fips, displayName }
    let countyLookup = new Map();
    let focusedIndex = -1;

    const fmtRate = d3.format(".1f");
    const fmtPop = d3.format(",");

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

    function normalize(value) {
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
            const displayName = firstRow.county;
            countyLookup.set(normalize(displayName), { fips, displayName });
        });
    }

    // --- Autocomplete ---

    function getSuggestions(query) {
        const q = normalize(query);
        if (q.length < 2) return [];
        return Array.from(countyLookup.values())
            .filter(({ fips, displayName }) => normalize(displayName).includes(q))
            .map(({ displayName }) => displayName)
            .slice(0, 8);
    }

    function renderSuggestions(names) {
        if (!names.length) {
            suggestionsEl.hidden = true;
            return;
        }
        suggestionsEl.innerHTML = names
            .map((name) => `<li role="option">${name}</li>`)
            .join("");
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
                selectSuggestion(items[focusedIndex].textContent);
                return;
            }
        }
        if (event.key === "Enter") handleSearch();
    });

    suggestionsEl.addEventListener("mousedown", (event) => {
        const li = event.target.closest("li");
        if (li) {
            event.preventDefault(); // prevent input blur before click fires
            selectSuggestion(li.textContent);
        }
    });

    document.addEventListener("click", (event) => {
        if (!countySearchInput.contains(event.target) && !suggestionsEl.contains(event.target)) {
            hideSuggestions();
        }
    });

    // --- Search & render ---

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
                <p><strong>Multiple counties matched your search.</strong> Please type the full county name and state.</p>
                <ul>${matches.slice(0, 8).map(({ displayName }) => `<li>${displayName}</li>`).join("")}</ul>
            `;
            return null;
        }

        return null;
    }

    function renderCountyResult(fips) {
        const rows = countyRows
            .filter((row) => row.fips === fips)
            .sort((a, b) => d3.ascending(a.year, b.year));

        if (!rows.length) { showMessage("No data found for this county."); return; }

        const firstRow = rows[0];
        const lastRow = rows[rows.length - 1];
        const totalChange = lastRow.rateMid - firstRow.rateMid;

        const directionText =
            totalChange > 0
                ? `increased by ${fmtRate(totalChange)} deaths per 100k`
                : totalChange < 0
                    ? `decreased by ${fmtRate(Math.abs(totalChange))} deaths per 100k`
                    : "stayed about the same";

        const tableRows = rows.map((row) => `
            <tr>
                <td>${row.year}</td>
                <td>${fmtRate(row.rateMid)}</td>
                <td>${fmtPop(row.population)}</td>
            </tr>
        `).join("");

        countyResult.innerHTML = `
            <h2>${lastRow.county}</h2>
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
                    <span>Estimated rate</span>
                    <strong>${fmtRate(lastRow.rateMid)}</strong>
                </div>
            </div>
            <p>
                In ${lastRow.year}, ${lastRow.county} had an estimated age-adjusted drug mortality rate of
                <strong>${fmtRate(lastRow.rateMid)} deaths per 100k people</strong>.
            </p>
            <p>
                From ${firstRow.year} to ${lastRow.year}, the county's estimated rate ${directionText}.
            </p>
            <table class="county-table">
                <thead>
                    <tr><th>Year</th><th>Estimated rate</th><th>Population</th></tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        `;
    }

    function handleSearch() {
        hideSuggestions();
        const fips = findFips(countySearchInput.value);
        if (!fips) {
            if (!countyResult.innerHTML.includes("Multiple counties")) {
                showMessage("County not found. Try a full name like <strong>San Diego County, CA</strong>.");
            }
            return;
        }
        renderCountyResult(fips);
    }

    async function initCountyExplorer() {
        showMessage("Loading county data…");

        const rawRows = await d3.csv(countyDataUrl, (row) => {
            const year = Number(row.Year);
            const population = parsePopulation(row.Population);
            const rateMid = parseRateRange(row[RATE_COL]);

            if (!Number.isFinite(year) || population == null || rateMid == null || !row.County || !row.FIPS) {
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

    initCountyExplorer().catch((error) => {
        console.error(error);
        showMessage("Could not load county data. Check that the CSV file is present and the page is served from a local web server.");
    });
})();
