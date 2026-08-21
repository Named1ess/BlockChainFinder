import { Outlet } from 'react-router-dom';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Layout } from 'antd';
import SearchBar from './components/SearchBar';
import HomePage from './pages/HomePage';
import AddressPage from './pages/AddressPage';
import TxPage from './pages/TxPage';

const { Header, Content, Footer } = Layout;

function AppLayout() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header className="app-header">
        <Link to="/">
          <div className="app-logo">⛓️ ChainFinder · 区块链资金溯源</div>
        </Link>
        <SearchBar />
      </Header>
      <Content style={{ padding: '16px 24px 32px' }}>
        <Outlet />
      </Content>
      <Footer style={{ textAlign: 'center', color: '#999', fontSize: 12 }}>
        数据来源：OKLink 网页端数据接口 · 本工具仅供研究学习使用
      </Footer>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/address/:chain/:address" element={<AddressPage />} />
          <Route path="/tx/:chain/:txid" element={<TxPage />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
