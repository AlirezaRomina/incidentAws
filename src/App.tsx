import { useRoute } from './router';
import { Board } from './components/home/Board';
import { Workspace } from './components/workspace/Workspace';
import { DebriefPage } from './components/debrief/Debrief';
import { incidentById } from './incidents';
import { NotFound } from './components/ui/NotFound';

export function App() {
  const route = useRoute();
  if (route.name === 'board') return <Board />;
  const inc = incidentById(route.id);
  if (!inc) return <NotFound />;
  if (route.name === 'play') return <Workspace key={inc.id} incident={inc} />;
  return <DebriefPage key={inc.id + (route.attempt ?? '')} incident={inc} attemptIndex={route.attempt} />;
}
