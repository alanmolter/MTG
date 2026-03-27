import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import CardSearch from "./pages/CardSearch";
import ArchetypeGenerator from "./pages/ArchetypeGenerator";
import SynergyGraph from "./pages/SynergyGraph";
import SharedDeck from "./pages/SharedDeck";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/archetype" component={ArchetypeGenerator} />
      <Route path="/search" component={CardSearch} />
      <Route path="/synergy" component={SynergyGraph} />
      <Route path="/shared/:shareId" component={SharedDeck} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
