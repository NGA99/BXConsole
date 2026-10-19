import { Shell } from './app/Shell';
import { useRoute } from './app/router';

export function App() {
  const route = useRoute();
  return <Shell route={route} />;
}
