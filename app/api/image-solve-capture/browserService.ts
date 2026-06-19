export function getBrowserServiceUrl() {
    const configuredUrl = process.env.BROWSER_SERVICE_URL?.trim();

    if (configuredUrl) {
        return configuredUrl.replace(/\/+$/, "");
    }

    if (process.env.NODE_ENV !== "production") {
        return "http://127.0.0.1:3001";
    }

    throw new Error("BROWSER_SERVICE_URL is not configured. Set it to the browser-service tunnel URL.");
}
