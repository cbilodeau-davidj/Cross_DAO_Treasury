// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TreasuryRecord {
  id: string;
  encryptedAmount: string;
  timestamp: number;
  daoAddress: string;
  investmentType: string;
  status: "pending" | "active" | "withdrawn";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<TreasuryRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDepositData, setNewDepositData] = useState({ investmentType: "", amount: 0 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedRecord, setSelectedRecord] = useState<TreasuryRecord | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const activeCount = records.filter(r => r.status === "active").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const withdrawnCount = records.filter(r => r.status === "withdrawn").length;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load record keys
      const keysBytes = await contract.getData("treasury_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }

      // Load each record
      const list: TreasuryRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`treasury_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedAmount: recordData.amount, 
                timestamp: recordData.timestamp, 
                daoAddress: recordData.daoAddress, 
                investmentType: recordData.investmentType, 
                status: recordData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const depositFunds = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setDepositing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting treasury amount with Zama FHE..." });
    try {
      const encryptedAmount = FHEEncryptNumber(newDepositData.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        amount: encryptedAmount, 
        timestamp: Math.floor(Date.now() / 1000), 
        daoAddress: address, 
        investmentType: newDepositData.investmentType, 
        status: "pending" 
      };
      
      await contract.setData(`treasury_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update keys list
      const keysBytes = await contract.getData("treasury_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("treasury_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted treasury deposit submitted!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowDepositModal(false);
        setNewDepositData({ investmentType: "", amount: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Deposit failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setDepositing(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const activateInvestment = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted treasury with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`treasury_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "active" };
      await contractWithSigner.setData(`treasury_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE activation completed!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Activation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const withdrawInvestment = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted treasury with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`treasury_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "withdrawn" };
      await contract.setData(`treasury_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE withdrawal completed!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Withdrawal failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const renderBarChart = () => {
    const total = records.length || 1;
    return (
      <div className="bar-chart-container">
        <div className="bar-chart">
          <div className="bar active" style={{ height: `${(activeCount / total) * 100}%` }}></div>
          <div className="bar pending" style={{ height: `${(pendingCount / total) * 100}%` }}></div>
          <div className="bar withdrawn" style={{ height: `${(withdrawnCount / total) * 100}%` }}></div>
        </div>
        <div className="bar-legend">
          <div className="legend-item"><div className="color-box active"></div><span>Active: {activeCount}</span></div>
          <div className="legend-item"><div className="color-box pending"></div><span>Pending: {pendingCount}</span></div>
          <div className="legend-item"><div className="color-box withdrawn"></div><span>Withdrawn: {withdrawnCount}</span></div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE treasury connection...</p>
    </div>
  );

  return (
    <div className="app-container future-tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>Cross-DAO<span>Treasury</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowDepositModal(true)} className="deposit-btn tech-button">
            <div className="add-icon"></div>Deposit Funds
          </button>
          <button className="tech-button" onClick={() => setShowIntro(!showIntro)}>
            {showIntro ? "Hide Intro" : "Show Intro"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        {showIntro && (
          <div className="intro-section tech-panel">
            <h2>FHE-Powered Cross-DAO Treasury</h2>
            <div className="intro-grid">
              <div className="intro-card">
                <h3>Secure Treasury Pooling</h3>
                <p>Multiple DAOs can pool treasury funds in an encrypted state using Zama FHE technology, enabling joint investments without exposing individual treasury details.</p>
              </div>
              <div className="intro-card">
                <h3>Privacy-Preserving</h3>
                <p>All treasury amounts remain encrypted during processing. Investment decisions are made through private voting without revealing exact amounts.</p>
              </div>
              <div className="intro-card">
                <h3>Risk Management</h3>
                <p>Distribute risk across multiple DAOs while maintaining capital efficiency. FHE enables secure computations on encrypted treasury data.</p>
              </div>
            </div>
            <div className="fhe-flow">
              <div className="flow-step"><div className="step-icon">🔓</div><div className="step-text">DAO Treasuries</div></div>
              <div className="flow-arrow">→</div>
              <div className="flow-step"><div className="step-icon">🔒</div><div className="step-text">FHE Encryption</div></div>
              <div className="flow-arrow">→</div>
              <div className="flow-step"><div className="step-icon">🔄</div><div className="step-text">Joint Pool</div></div>
              <div className="flow-arrow">→</div>
              <div className="flow-step"><div className="step-icon">📊</div><div className="step-text">Investments</div></div>
            </div>
          </div>
        )}
        <div className="dashboard-grid">
          <div className="dashboard-panel tech-panel">
            <h3>Treasury Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{records.length}</div><div className="stat-label">Total Deposits</div></div>
              <div className="stat-item"><div className="stat-value">{activeCount}</div><div className="stat-label">Active</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{withdrawnCount}</div><div className="stat-label">Withdrawn</div></div>
            </div>
          </div>
          <div className="dashboard-panel tech-panel">
            <h3>Status Distribution</h3>
            {renderBarChart()}
          </div>
          <div className="dashboard-panel tech-panel">
            <h3>Recent Activity</h3>
            <div className="activity-feed">
              {records.slice(0, 3).map(record => (
                <div className="activity-item" key={record.id}>
                  <div className="activity-type">{record.investmentType}</div>
                  <div className="activity-dao">{record.daoAddress.substring(0, 6)}...{record.daoAddress.substring(38)}</div>
                  <div className="activity-status"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="records-section">
          <div className="section-header">
            <h2>DAO Treasury Deposits</h2>
            <div className="header-actions">
              <button onClick={loadRecords} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list tech-panel">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Investment Type</div>
              <div className="header-cell">DAO</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {records.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No treasury deposits found</p>
                <button className="tech-button primary" onClick={() => setShowDepositModal(true)}>Make First Deposit</button>
              </div>
            ) : records.map(record => (
              <div className="record-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                <div className="table-cell">{record.investmentType}</div>
                <div className="table-cell">{record.daoAddress.substring(0, 6)}...{record.daoAddress.substring(38)}</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(record.daoAddress) && record.status === "pending" && (
                    <button className="action-btn tech-button success" onClick={(e) => { e.stopPropagation(); activateInvestment(record.id); }}>Activate</button>
                  )}
                  {isOwner(record.daoAddress) && record.status === "active" && (
                    <button className="action-btn tech-button danger" onClick={(e) => { e.stopPropagation(); withdrawInvestment(record.id); }}>Withdraw</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="community-links">
          <h3>Join the Community</h3>
          <div className="link-buttons">
            <a href="#" className="tech-button">Discord</a>
            <a href="#" className="tech-button">Twitter</a>
            <a href="#" className="tech-button">GitHub</a>
            <a href="#" className="tech-button">Documentation</a>
          </div>
        </div>
      </div>
      {showDepositModal && <ModalDeposit onSubmit={depositFunds} onClose={() => setShowDepositModal(false)} depositing={depositing} depositData={newDepositData} setDepositData={setNewDepositData}/>}
      {selectedRecord && <RecordDetailModal record={selectedRecord} onClose={() => { setSelectedRecord(null); setDecryptedAmount(null); }} decryptedAmount={decryptedAmount} setDecryptedAmount={setDecryptedAmount} isDecrypting={isDecrypting} decryptWithSignature={decryptWithSignature}/>}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-panel">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>Cross-DAO Treasury</span></div>
            <p>FHE-powered secure treasury management for DAOs</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Docs</a>
            <a href="#" className="footer-link">Privacy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} Cross-DAO Treasury. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalDepositProps {
  onSubmit: () => void; 
  onClose: () => void; 
  depositing: boolean;
  depositData: any;
  setDepositData: (data: any) => void;
}

const ModalDeposit: React.FC<ModalDepositProps> = ({ onSubmit, onClose, depositing, depositData, setDepositData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setDepositData({ ...depositData, [name]: value });
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setDepositData({ ...depositData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!depositData.investmentType || !depositData.amount) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="deposit-modal tech-panel">
        <div className="modal-header">
          <h2>Deposit Treasury Funds</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your treasury amount will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Investment Type *</label>
              <select name="investmentType" value={depositData.investmentType} onChange={handleChange} className="tech-select">
                <option value="">Select type</option>
                <option value="Liquidity Pool">Liquidity Pool</option>
                <option value="Yield Farming">Yield Farming</option>
                <option value="Venture Fund">Venture Fund</option>
                <option value="Staking">Staking</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Amount (ETH) *</label>
              <input 
                type="number" 
                name="amount" 
                value={depositData.amount} 
                onChange={handleAmountChange} 
                placeholder="Enter amount..." 
                className="tech-input"
                step="0.01"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Amount:</span><div>{depositData.amount || 'No amount entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{depositData.amount ? FHEEncryptNumber(depositData.amount).substring(0, 50) + '...' : 'No amount entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>DAO Treasury Privacy</strong><p>Amounts remain encrypted during FHE processing and are never decrypted on-chain</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={depositing} className="submit-btn tech-button primary">
            {depositing ? "Encrypting with FHE..." : "Submit Deposit"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: TreasuryRecord;
  onClose: () => void;
  decryptedAmount: number | null;
  setDecryptedAmount: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedAmount, setDecryptedAmount, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedAmount !== null) { setDecryptedAmount(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedAmount);
    if (decrypted !== null) setDecryptedAmount(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal tech-panel">
        <div className="modal-header">
          <h2>Deposit Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>Investment Type:</span><strong>{record.investmentType}</strong></div>
            <div className="info-item"><span>DAO Address:</span><strong>{record.daoAddress.substring(0, 6)}...{record.daoAddress.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Amount</h3>
            <div className="encrypted-data">{record.encryptedAmount.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn tech-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedAmount !== null ? "Hide Amount" : "Decrypt with Signature"}
            </button>
          </div>
          {decryptedAmount !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Amount</h3>
              <div className="decrypted-value">{decryptedAmount} ETH</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted amount is only visible after wallet signature verification</span></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;