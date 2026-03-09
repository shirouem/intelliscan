import ScannerApp from "./components/ScannerApp";
import "./page.css";

export default function Home() {
  return (
    <main className="app-main">
      <header className="app-header">
        <div className="header-content">
          <div className="logo-wrapper">
            <div className="logo-icon"></div>
          </div>
          <div>
            <h1>IntelliScan</h1>
            <p className="subtitle">AI Question Paper Digitizer</p>
          </div>
        </div>
      </header>

      <div className="app-content">
        <ScannerApp />
      </div>
    </main>
  );
}
