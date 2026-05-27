function initTheme() {
    const themeToggleBtn = document.querySelector("#theme-toggle");

    if (!themeToggleBtn) {
        return;
    }

    const themeIcon = themeToggleBtn.querySelector(".theme-icon");
    const themeLabel = themeToggleBtn.querySelector(".theme-label");

    const savedTheme = localStorage.getItem("solarized-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initialTheme = savedTheme || (prefersDark ? "dark" : "light");

    setTheme(initialTheme);

    themeToggleBtn.addEventListener("click", () => {
        const currentTheme = document.body.classList.contains("theme-dark") ? "dark" : "light";
        const nextTheme = currentTheme === "light" ? "dark" : "light";
        setTheme(nextTheme);
    });

    function setTheme(theme) {
        if (theme === "dark") {
            document.body.classList.remove("theme-light");
            document.body.classList.add("theme-dark");

            if (themeIcon) themeIcon.textContent = "☾";
            if (themeLabel) themeLabel.textContent = "Minimal Dark";

            localStorage.setItem("solarized-theme", "dark");
        } else {
            document.body.classList.remove("theme-dark");
            document.body.classList.add("theme-light");

            if (themeIcon) themeIcon.textContent = "☀";
            if (themeLabel) themeLabel.textContent = "Minimal Light";

            localStorage.setItem("solarized-theme", "light");
        }
    }
}