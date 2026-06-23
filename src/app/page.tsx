import { getHomeSections } from '@/lib/queries/home';
import { HomeView } from '@/components/home/HomeView';

export default async function Home() {
  const sections = await getHomeSections();
  return <HomeView {...sections} />;
}
