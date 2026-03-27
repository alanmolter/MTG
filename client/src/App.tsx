import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import CardSearch from "./pages/CardSearch";
import DeckBuilder from "./pages/DeckBuilder";
import DeckGenerator from "./pages/DeckGenerator";
import SyncData from "./pages/SyncData";
import Pipeline from "./pages/Pipeline";
import ArchetypeGenerator from "./pages/ArchetypeGenerator";
import Clustering from "./pages/Clustering";
import SynergyGraph from "./pages/SynergyGraph";
import DeckVisualization from "./pages/DeckVisualization";
import DeckSharing from "./pages/DeckSharing";
import SharedDeck from "./pages/SharedDeck";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/search" component={CardSearch} />
      <Route path="/decks" component={DeckBuilder} />
      <Route path="/generator" component={DeckGenerator} />
      <Route path="/sync" component={SyncData} />
      <Route path="/pipeline" component={Pipeline} />
      <Route path="/archetype" component={ArchetypeGenerator} />
      <Route path="/clustering" component={Clustering} />
      <Route path="/synergy" component={SynergyGraph} />
      <Route path="/visualization" component={DeckVisualization} />
      <Route path="/sharing" component={DeckSharing} />
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
